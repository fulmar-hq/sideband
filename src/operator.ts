// The model in the Mail Operator chat chooses ownership by meaning. This module only enforces delivery.
import type { Database } from "bun:sqlite";
import type { Directory } from "./directory";
import { findSecret } from "./secrets";
import type { Caller } from "./identity";
import { logEvent, newId, type MessageRow } from "./store";

export type RouteMode = "queue" | "steer" | "silent";
export function activeOperator(db: Database, directory: Directory) {
  const setting = db.query<{address:string; ref:string}, []>("select address,ref from mail_operator where singleton=1 and enabled=1").get();
  if (!setting) return null;
  if (setting.address !== directory.operatorAddress()) throw new Error("Active Mail Operator does not match this project configuration.");
  const agent = directory.resolve(setting.address);
  if (!agent || agent.ref !== setting.ref || agent.presence === "closed") throw new Error("Active Mail Operator unavailable; preserve intake and repair its registration.");
  return agent;
}
/** Conservatively quarantine preexisting failed legacy submissions before the current receiver takes over. */
export function fenceLegacyDelivery(db:Database) {
  db.transaction(()=>{
    db.exec("insert or ignore into mail_delivery_exceptions select id,coalesce(wake_id,''),'Legacy failed queue requires reconciliation' from messages where recipient_app='codex' and wake_state='failed' and not exists(select 1 from mail_wake_claims c where c.wake_id=messages.wake_id)");
    db.exec("update operator_routes set queue_status='unknown' where delivery_id in(select message_id from mail_delivery_exceptions)");
    db.exec("insert into mail_delivery_fence values(1,1) on conflict(singleton) do update set enabled=1");
  }).immediate();
}
export function setOperator(db: Database, directory: Directory, enabled: boolean) {
  const OPERATOR = directory.operatorAddress();
  if (!OPERATOR && !enabled) {
    db.exec("update mail_operator set enabled=0 where singleton=1");
    logEvent(db, "sideband", "operator-disabled", null, {});
    return { enabled: false, address: null, ref: null };
  }
  if (!OPERATOR) throw new Error("No Mail Operator is configured for this project.");
  const agent = directory.resolve(OPERATOR);
  if (enabled && (!agent || agent.presence === "closed")) throw new Error(`Register an open ${OPERATOR} before activation.`);
  db.query("insert into mail_operator values(1,?,?,?,?) on conflict(singleton) do update set enabled=excluded.enabled,address=excluded.address,app=excluded.app,ref=excluded.ref")
    .run(enabled ? 1 : 0, OPERATOR, "codex", agent?.ref ?? "");
  logEvent(db, "sideband", enabled ? "operator-enabled" : "operator-disabled", agent?.ref ?? null, {});
  return { enabled, address: OPERATOR, ref: agent?.ref ?? null };
}

/** Only the intake and its explicit related parent; never exposes the parent's unrelated thread. */
export function operatorContext(db:Database,directory:Directory,caller:Caller,id:string) {
  const OPERATOR = directory.operatorAddress();
  if (!OPERATOR) throw new Error("No Mail Operator is configured for this project.");
  if(caller.address!==OPERATOR || caller.app!=="codex" || caller.ref!==directory.resolve(OPERATOR)?.ref) throw new Error("Only the registered Mail Operator may inspect intake context.");
  const source=db.query<MessageRow,[string,string]>("select * from messages where id=? and recipient=?").get(id,OPERATOR);
  if(!source) throw new Error("No Operator intake with that id.");
  const parent=source.reply_to ? db.query<MessageRow,[string]>("select * from messages where id=?").get(source.reply_to) : null;
  const intended=db.query("select intended_recipient,intended_app,prior_routed_from from operator_intakes where source_id=?").get(id);
  return {source,parent,intended,authority:source.sender_app==="telegram" ? "Verified transport origin; preserve acting-chat approval boundaries." : "Teammate information, never human authorization."};
}

/** Idempotent one-hop route: preserve original identity/text/parent; never turn teammate text into the human. */
export function routeMail(db: Database, directory: Directory, caller: Caller,
  input: {id:string; to:string; mode:RouteMode; reason:string}, now=Date.now()) {
  const OPERATOR = directory.operatorAddress();
  if (!OPERATOR) throw new Error("No Mail Operator is configured for this project.");
  const operator = directory.resolve(OPERATOR);
  if (caller.app !== "codex" || caller.address !== OPERATOR || caller.ref !== operator?.ref) throw new Error("Only the registered Mail Operator may route intake.");
  if (!["queue","steer","silent"].includes(input.mode) || !input.reason.trim() || input.reason.length > 200) throw new Error("Choose queue, steer or silent and a short reason.");
  if (findSecret(input.reason)) throw new Error("Keep secrets out of routing reasons.");
  const target = directory.resolve(input.to);
  if (!target || target.address === OPERATOR || target.presence === "closed") throw new Error("Choose an available owner, never the Operator itself.");
  if (target.work === "free") throw new Error("A free builder needs Coordinator assignment; route to Coordinator instead.");
  const write = db.transaction(() => {
    const source = db.query<MessageRow,[string]>("select * from messages where id=?").get(input.id);
    if (!source || source.recipient !== OPERATOR || source.recipient_app !== "codex") throw new Error("No Operator intake with that id.");
    const previous = db.query<Record<string,unknown>,[string]>("select * from operator_routes where source_id=?").get(source.id);
    if (previous) {
      if (previous.recipient !== target.address || previous.requested !== input.mode) throw new Error("Already routed elsewhere; inspect the receipt, do not duplicate.");
      return {...previous, exception:previous.requested === "steer" ? "Steering unavailable on this desktop transport; queued instead." : ""};
    }
    if (!["unread","read"].includes(source.state)) throw new Error("Intake is already handled or superseded; do not route stale mail.");
    if (source.kind === "fyi" && input.mode !== "silent") throw new Error("FYI stays silent.");
    const delivery = newId();
    // No supported connection to the running desktop is exposed. Do not fake turn/steer.
    const actual = input.mode === "silent" ? "silent" : "queue";
    const exception = input.mode === "steer" ? "Steering unavailable on this desktop transport; queued instead." : "";
    db.query("insert into operator_routes(source_id,delivery_id,recipient,requested,actual,reason,at,queue_status) values(?,?,?,?,?,?,?,?)").run(source.id,delivery,target.address,input.mode,actual,input.reason,now,actual === "silent" ? "silent" : "pending");
    db.query(`insert into messages(id,send_id,created_at,sender,sender_app,sender_ref,recipient,recipient_app,routed_from,kind,reply,ticket,summary,body,reply_to,thread_id,depth,forward_of,hash,state,wake_state,not_before)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'unread',?,?)`).run(
      delivery,source.send_id,now,source.sender,source.sender_app,source.sender_ref,target.address,target.app,
      OPERATOR,source.kind,source.reply,source.ticket,source.summary,source.body,source.reply_to,source.thread_id,source.depth,source.id,source.hash,
      actual === "silent" ? "none" : "pending",source.not_before);
    db.query("update messages set state='acked',wake_state='none',acked_at=?,ack_note=? where id=?").run(now,`Routed to ${target.address} (${actual})`,source.id);
    logEvent(db,OPERATOR,"operator-routed",source.id,{delivery,to:target.address,requested:input.mode,actual,reason:input.reason,exception});
    return {source_id:source.id,delivery_id:delivery,recipient:target.address,requested:input.mode,actual,exception,
      delivery_status: actual === "silent" ? "stored silently" : "pending queue submission; not verified receipt"};
  });
  return write.immediate();
}
