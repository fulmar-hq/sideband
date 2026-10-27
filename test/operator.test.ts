import { describe, expect, test } from "bun:test";
import { sendMail, inbox } from "../src/mail";
import { routeMail, setOperator, operatorContext, fenceLegacyDelivery } from "../src/operator";
import { acceptUpdate, formatForTelegram, takePollLease } from "../src/telegram";
import { dueBatch, ringCodex, claim } from "../src/wake";
import { openStore, type MessageRow } from "../src/store";
import { RECEIVER_VERSION } from "../src/operator-receiver";
import { standardWorld } from "./fixture";
const OPERATOR="Router";
const setup=()=>{const w=standardWorld(); w.cfg.project.operator=OPERATOR; w.codexThread({address:OPERATOR,id:"t-operator",name:"Routing",role:"expert"}); setOperator(w.db,w.directory,true); return w;};
const send=(w:ReturnType<typeof setup>,summary="Please check current source",kind:"action"|"fyi"="action")=>sendMail(w.db,w.cfg,w.directory,w.codex("t-developer"),{to:"Planner",kind,reply:"none",summary,ticket:"TASK-2"}).deliveries[0]!.id;
const row=(w:ReturnType<typeof setup>,id:string)=>w.db.query<MessageRow,[string]>("select * from messages where id=?").get(id)!;
const creds={token:"123:fake",chatId:"424242"};
const update=(id:number,parent?:number)=>({update_id:id,message:{message_id:id+100,chat:{id:424242},from:{id:424242},text:"Please check the new work",...(parent?{reply_to_message:{message_id:parent}}:{})}});
describe("operator intake and routing",()=>{
 test("cutover routes coordinator intake, direct owner stays direct, rollback preserves history",()=>{
  const w=setup(); const id=send(w); expect(row(w,id).recipient).toBe(OPERATOR);
  const direct=sendMail(w.db,w.cfg,w.directory,w.claude(w.pids.b10),{to:"Developer",kind:"action",reply:"none",summary:"Direct owner question"}).deliveries[0]!;
  expect(row(w,direct.id).recipient).toBe("Developer");
  setOperator(w.db,w.directory,false); expect(row(w,send(w,"After rollback")).recipient).toBe("Planner"); expect(row(w,id).recipient).toBe(OPERATOR);
 });
 test("one-hop routing preserves teammate identity, is idempotent, rejects stale/self/unauthorized routes",()=>{
  const w=setup(),id=send(w),op=w.codex("t-operator");
  const input={id,to:"Planner",mode:"steer" as const,reason:"Urgent correction changes active work"};
  expect(()=>routeMail(w.db,w.directory,w.codex("t-developer"),input)).toThrow("Only the registered");
  expect(()=>routeMail(w.db,w.directory,op,{...input,to:OPERATOR})).toThrow("never the Operator");
  const receipt=routeMail(w.db,w.directory,op,input);
  expect(receipt).toMatchObject({requested:"steer",actual:"queue",exception:expect.stringContaining("unavailable")});
  const dest=row(w,String(receipt.delivery_id)); expect(dest).toMatchObject({sender:"Developer",sender_app:"codex",summary:row(w,id).summary,recipient:"Planner",forward_of:id});
  expect(routeMail(w.db,w.directory,op,input).delivery_id).toBe(receipt.delivery_id);
  expect(()=>routeMail(w.db,w.directory,op,{...input,to:"Developer"})).toThrow("Already routed");
  const stale=send(w,"Old message"); send(w,"Replacement message");
  expect(()=>routeMail(w.db,w.directory,op,{...input,id:stale})).toThrow("superseded");
 });
 test("verified Telegram text and explicit parent survive operator routing; unthreaded does not guess",()=>{
  const w=setup();
  w.db.exec("insert into telegram_messages values(77,'parent',0)");
  const parent=sendMail(w.db,w.cfg,w.directory,w.claude(w.pids.b10),{to:"Developer",kind:"decision",reply:"required",summary:"A real context question",ticket:"TASK-2"}).deliveries[0]!.id;
  w.db.query("update telegram_messages set mail_id=? where message_id=77").run(parent);
  const accepted=acceptUpdate(w.db,creds,w.directory,update(1,77)); expect(accepted.outcome).toBe("delivered");
  if(accepted.outcome!=="delivered")return;
  const result=routeMail(w.db,w.directory,w.codex("t-operator"),{id:accepted.mailId,to:"Developer",mode:"queue",reason:"Explicit owner context"});
  expect(row(w,String(result.delivery_id))).toMatchObject({sender:"Owner",sender_app:"telegram",sender_ref:"telegram:101",reply_to:parent,ticket:"TASK-2",summary:"Please check the new work"});
  const unthreaded=acceptUpdate(w.db,creds,w.directory,update(2)); expect(unthreaded).toMatchObject({outcome:"delivered",to:OPERATOR,parentId:null});
  const forged=update(3); forged.message.from.id=999; expect(acceptUpdate(w.db,creds,w.directory,forged).outcome).toBe("dropped");
 });
 test("FYI stays silent; no duplicate intake or post-read wake",async()=>{
  const w=setup(),id=send(w,"Background information","fyi");
  const op=w.codex("t-operator"),input={id,to:"Developer",mode:"silent" as const,reason:"No action needed"};
  expect(()=>routeMail(w.db,w.directory,op,{...input,mode:"queue"})).toThrow("FYI stays silent");
  expect(row(w,String(routeMail(w.db,w.directory,op,input).delivery_id)).wake_state).toBe("none");
  const current=send(w,"Read before ringing"); inbox(w.db,w.cfg,op,10);
  expect(dueBatch(w.db,w.cfg,OPERATOR,"codex",Date.now()+5000)).toBeNull();
  expect(()=>send(w,"Read before ringing")).toThrow("Duplicate");
  expect(row(w,current).state).toBe("read");
 });
 test("failed queue stays retriable without a duplicate routed delivery",async()=>{
  const w=setup(),id=send(w); const receipt=routeMail(w.db,w.directory,w.codex("t-operator"),{id,to:"Developer",mode:"queue",reason:"Owner work"});
  const at=Date.now()+5000;
  await ringCodex(w.db,w.cfg,w.directory,"test",at,async()=>({ok:false,detail:"transport unavailable"}));
  expect(row(w,String(receipt.delivery_id)).wake_state).toBe("failed");
  await ringCodex(w.db,w.cfg,w.directory,"test",at+310000,async()=>({ok:true,detail:"queued"}));
  expect(row(w,String(receipt.delivery_id)).wake_state).toBe("woken");
  expect(w.db.query<{n:number},[]>("select count(*) n from operator_routes").get()!.n).toBe(1);
 });
 test("late legacy Telegram root is atomically captured with intended target and parent, never re-routed on rollback",()=>{
  const w=setup(),id=send(w);
  const source=row(w,id);
  w.db.query(`insert into messages(id,send_id,created_at,sender,sender_app,sender_ref,recipient,recipient_app,kind,reply,ticket,summary,body,reply_to,thread_id,depth,hash,state,wake_state)
    values('legacy','s-legacy',?,'Owner','telegram','telegram:777','Developer','codex','action','none',?,'Exact human text','Original body',?, ?,1,'legacy-hash','unread','pending')`).run(Date.now(),source.ticket,id,source.thread_id);
  const ctx=operatorContext(w.db,w.directory,w.codex("t-operator"),"legacy");
  expect(ctx.intended).toMatchObject({intended_recipient:"Developer",intended_app:"codex"});
  expect(ctx.parent?.id).toBe(id); expect(ctx.source.sender_ref).toBe("telegram:777");
  setOperator(w.db,w.directory,false);
  expect(row(w,"legacy").recipient).toBe(OPERATOR);
  expect(routeMail(w.db,w.directory,w.codex("t-operator"),{id:"legacy",to:"Developer",mode:"queue",reason:"Explicit owner context"}).actual).toBe("queue");
 });
 test("duplicate Telegram root on handover and old offsets never duplicate or regress",()=>{
  const w=setup(); const a=acceptUpdate(w.db,creds,w.directory,update(9));
  expect(a.outcome).toBe("delivered");
  expect(acceptUpdate(w.db,creds,w.directory,update(9)).outcome).toBe("ignored");
  w.db.query("update telegram_state set value='2' where key='offset'").run();
  expect(w.db.query<{value:string},[]>("select value from telegram_state where key='offset'").get()!.value).toBe("10");
  expect(w.db.query<{n:number},[]>("select count(*) n from messages where sender_app='telegram'").get()!.n).toBe(1);
 });
 test("partial wake claims exclude rows read or claimed elsewhere after selection",()=>{
  const w=setup(),first=send(w,"First unscoped");
  const second=sendMail(w.db,w.cfg,w.directory,w.codex("t-developer"),{to:"Planner",kind:"decision",reply:"none",summary:"Second unscoped"}).deliveries[0]!.id;
  const batch=dueBatch(w.db,w.cfg,OPERATOR,"codex",Date.now()+5000)!;
  w.db.query("update messages set state='read' where id=?").run(first);
  expect(claim(w.db,batch,"test-claim")).toBe(true);
  expect(batch.rows.map(r=>r.id)).toEqual([second]);
 });
 test("ambiguous queue outcome is preserved without automatic resubmission",async()=>{
  const w=setup(),id=send(w),op=w.codex("t-operator");
  const input={id,to:"Developer",mode:"steer" as const,reason:"Urgent active-turn change"};
  const receipt=routeMail(w.db,w.directory,op,input);
  let calls=0; const queue=async()=>{calls++;return {ok:false,unknown:true,detail:"command timed out after possible acceptance"};};
  const at=Date.now()+5000;
  await ringCodex(w.db,w.cfg,w.directory,"test",at,queue);
  await ringCodex(w.db,w.cfg,w.directory,"test",at+310000,queue);
  expect(calls).toBe(1);
  expect(routeMail(w.db,w.directory,op,input)).toMatchObject({queue_status:"unknown",delivery_id:receipt.delivery_id});
 });

 test("upgrades the initial operator table without losing existing source rows; Operator Telegram has no role header",()=>{
  const w=setup(),id=send(w); const old=row(w,id);
  expect(formatForTelegram({...old,sender:OPERATOR,summary:"I can route that now",body:""},w.cfg)).toBe("I can route that now");
  w.db.close();
  const { Database }=require("bun:sqlite"); const legacy=new Database(w.cfg.db);
  legacy.exec("alter table operator_routes drop column queue_status; alter table operator_routes drop column queue_item; delete from mail_schema_versions where name='operator'"); legacy.close();
  const upgraded=openStore(w.cfg.db);
  expect(upgraded.query("select id from messages where id=?").get(id)).toEqual({id});
  expect(upgraded.query<{name:string},[]>("pragma table_info(operator_routes)").all().map(c=>c.name)).toContain("queue_status");
  upgraded.close();
 });

 test("different verified Telegram messages with identical text remain distinct",()=>{
  const w=setup(); expect(acceptUpdate(w.db,creds,w.directory,update(21)).outcome).toBe("delivered");
  expect(acceptUpdate(w.db,creds,w.directory,update(22)).outcome).toBe("delivered");
  expect(w.db.query<{n:number},[]>("select count(*) n from messages where sender_app='telegram'").get()!.n).toBe(2);
 });
 test("an old whole-cycle ringer cannot claim another recipient even after the drain window",()=>{
  const w=setup(),id=send(w);
  const next=sendMail(w.db,w.cfg,w.directory,w.claude(w.pids.b10),{to:"Developer",kind:"action",reply:"none",summary:"Another direct owner"}).deliveries[0]!.id;
  const selected=dueBatch(w.db,w.cfg,OPERATOR,"codex",Date.now()+5000)!;
  w.db.exec("insert into mail_delivery_fence values(1,1)");
  // Exact old-code update after 36 seconds still cannot acquire a new claim.
  expect(w.db.query("update messages set wake_state='woken',wake_id='old' where id=? and wake_state in ('pending','failed','digest')").run(next).changes).toBe(0);
  expect(row(w,next).wake_state).toBe("pending");
  expect(claim(w.db,selected,"current-claim")).toBe(true);
  expect(row(w,id).wake_id).toBe("current-claim");
 });

 test("version1 installed SQL is replaced by version3 and permits distinct same-text human replies",()=>{
  const w=setup();
  w.db.exec(`drop trigger operator_duplicate;
    create trigger operator_duplicate before insert on messages
    when new.sender_app='telegram' and exists(select 1 from messages where sender_app='telegram' and hash=new.hash)
    begin select raise(abort,'old content dedup'); end;
    update mail_schema_versions set version=1 where name='operator';`);
  w.db.close(); const upgraded=openStore(w.cfg.db); w.db=upgraded;
  expect(upgraded.query<{version:number},[]>("select version from mail_schema_versions where name='operator'").get()!.version).toBe(3);
  expect(acceptUpdate(upgraded,creds,w.directory,update(31)).outcome).toBe("delivered");
  expect(acceptUpdate(upgraded,creds,w.directory,update(32)).outcome).toBe("delivered");
  upgraded.exec("insert into mail_delivery_fence values(1,1)");
  const id=send(w,"Post-upgrade old-loop claim");
  expect(upgraded.query("update messages set wake_state='woken',wake_id='old-loop' where id=?").run(id).changes).toBe(0);
 });

 test("legacy claimed queue accepted then timed out cannot become a duplicate retry",async()=>{
  const w=setup(),id=send(w);
  // The old ringer claimed this before the new fence and may have queued it already.
  w.db.query("update messages set wake_state='woken',wake_id='old-inflight' where id=?").run(id);
  fenceLegacyDelivery(w.db);
  w.db.query("update messages set wake_state='failed' where id=? and wake_id='old-inflight'").run(id);
  expect(row(w,id).wake_state).toBe("woken");
  let calls=0; await ringCodex(w.db,w.cfg,w.directory,"current",Date.now()+310000,async()=>{calls++;return {ok:true,detail:"queued"};});
  expect(calls).toBe(0);
  expect(w.db.query("select message_id from mail_delivery_exceptions where message_id=?").get(id)).toEqual({message_id:id});
 });

 test("dedicated receiver can fence an already-current per-chat poller without restarting it",()=>{
  const w=setup(),now=Date.now();
  expect(takePollLease(w.db,"loaded-current-chat",now)).toBe(true);
  expect(takePollLease(w.db,"dedicated",now+1,RECEIVER_VERSION)).toBe(true);
  expect(takePollLease(w.db,"loaded-current-chat",now+2)).toBe(false);
  expect(takePollLease(w.db,"dedicated",now+3,RECEIVER_VERSION)).toBe(true);
 });

});
