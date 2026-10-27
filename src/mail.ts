// Sending and reading mail, with the noise rules applied at the door.
import type { Database } from "bun:sqlite";
import { LIMITS, type Config } from "./config";
import type { Agent, Directory } from "./directory";
import type { Caller } from "./identity";
import { findSecret } from "./secrets";
import { KINDS, WAKING_KINDS, liveMailRefs, logEvent, newId, sha256, type Endpoint, type Kind, type MessageRow } from "./store";
import { telegramConfigured } from "./telegram";
import { humanAddress, humanLabel, mailName, authorityNote, verifiedNote } from "./context";
import { ticketPattern } from "./project-config";
export { AUTHORITY_NOTE, HUMAN_NOTE, TEAMMATE_NOTE } from "./context";

export class MailError extends Error {}


const NEVER_REFUSED: ReadonlySet<Kind> = new Set(["blocker", "handoff"]);

export interface SendInput {
  to: string | string[];
  kind?: Kind;
  reply: "required" | "none";
  summary: string;
  body?: string;
  ticket?: string;
  reply_to?: string;
  forward_of?: string;
  note?: string;
}

export interface SendResult {
  sendId: string;
  deliveries: { id: string; to: string; app: string; routedFrom?: string; outlook: string }[];
  superseded: number;
}

export { findSecret } from "./secrets";

function clean(text: string | undefined): string {
  return (text ?? "").replace(/\r\n/g, "\n").trim();
}

export function sendMail(db: Database, cfg: Config, directory: Directory, caller: Caller, input: SendInput, now = Date.now()): SendResult {
  const human = humanAddress(cfg);
  if (!caller.address) throw new MailError(caller.problem ?? "This process has no configured Sideband identity.");
  if (input.kind !== undefined && !KINDS.includes(input.kind)) throw new MailError(`kind must be one of ${KINDS.join(", ")}.`);
  if (input.kind === undefined && !input.forward_of) throw new MailError(`kind is required: ${KINDS.join(", ")}.`);
  if (input.reply !== "required" && input.reply !== "none") throw new MailError('reply must be "required" or "none".');
  const ticket = clean(input.ticket) || null;
  if (ticket && (ticket.match(ticketPattern(cfg.project.tickets))?.[0] !== ticket)) throw new MailError("ticket must use a configured prefix followed by digits.");

  let summary = clean(input.summary).replace(/\s*\n\s*/g, " ");
  let body = clean(input.body);
  let kind = input.kind as Kind;
  let forwardOf: MessageRow | null = null;
  if (input.forward_of) {
    forwardOf = visibleMessage(db, caller.address, input.forward_of);
    if (!forwardOf) throw new MailError(`No message ${input.forward_of} that you sent or received.`);
    const note = clean(input.note);
    if (note.length > LIMITS.ackChars) throw new MailError(`A forwarding note is at most ${LIMITS.ackChars} characters.`);
    // Forward, don't paraphrase: the original text travels unchanged.
    summary = forwardOf.summary;
    body = [`[Forwarded by ${caller.address} from ${forwardOf.sender}, ${forwardOf.id}${note ? `: ${note}` : ""}]`, forwardOf.body]
      .filter(Boolean)
      .join("\n");
    kind = input.kind ?? forwardOf.kind;
  } else {
    if (!summary) throw new MailError("summary is required: one bottom-line-first sentence.");
    if (summary.length > LIMITS.summaryChars)
      throw new MailError(`summary is ${summary.length} characters; the limit is ${LIMITS.summaryChars}. Lead with the bottom line.`);
    if (body.length > LIMITS.bodyChars)
      throw new MailError(
        `body is ${body.length} characters; the limit is ${LIMITS.bodyChars}. Put the detail in the owning project record or PR and send the link.`,
      );
  }
  const secret = findSecret(`${summary}\n${body}`);
  if (secret) throw new MailError(`Refused: the message looks like it contains ${secret}. Keep secrets and personal data out of mail.`);

  const targets = [...new Set((Array.isArray(input.to) ? input.to : [input.to ?? ""]).flatMap((t) => String(t).split(",")).map((t) => t.trim()).filter(Boolean))];
  if (targets.length === 0) throw new MailError("to is required.");
  if (targets.length > LIMITS.recipientsPerSend)
    throw new MailError(`At most ${LIMITS.recipientsPerSend} recipients. Send to the owner, not everyone who might care.`);

  let parent: MessageRow | null = null;
  if (input.reply_to) {
    parent = visibleMessage(db, caller.address, input.reply_to);
    if (!parent) throw new MailError(`No message ${input.reply_to} that you sent or received.`);
    if (parent.depth + 1 > LIMITS.threadDepth)
      throw new MailError(`This thread has ${parent.depth + 1} replies. Settle it in the owning project record instead of more mail.`);
  }

  const resolved = new Map<string, { agent: Agent; routedFrom?: string }>();
  let toHuman = false;
  for (const target of targets) {
    if (human && target.toLowerCase() === human.toLowerCase()) {
      if (!telegramConfigured(cfg))
        throw new MailError("The configured human's Telegram is not connected.");
      if (kind === "fyi")
        throw new MailError("The human recipient gets results and blockers, not FYI.");
      toHuman = true;
      continue;
    }
    const agent = directory.resolve(target);
    if (!agent) throw new MailError(`Unknown address "${target}". Call agents to see who exists.`);
    let destination = agent;
    let routedFrom: string | undefined;
    // A free builder has no work to act on; its coordinator decides (unless a coordinator is launching it).
    if (agent.work === "free" && caller.role !== "coordinator") {
      const coordinator = directory.coordinator(agent.app);
      if (coordinator) {
        destination = coordinator;
        routedFrom = agent.address;
      }
    }
    if (destination.address === caller.address && destination.app === caller.app)
      throw new MailError(routedFrom ? `${routedFrom} is free and routes to you; nothing to send.` : "You can't mail yourself.");
    resolved.set(`${destination.app}:${destination.address}`, { agent: destination, routedFrom });
  }

  const live = liveMailRefs(db, now);
  const sendId = newId("s");
  const threadId = parent?.thread_id ?? sendId;
  const depth = parent ? parent.depth + 1 : 0;
  const hash = sha256([kind, ticket ?? "", summary, body].join("\u001f"));
  const deliveries: SendResult["deliveries"] = [];
  let superseded = 0;

  const write = db.transaction(() => {
    if (toHuman) {
      const duplicate = db
        .query<{ id: string }, [string, string, string, number]>(
          "select id from messages where sender = ? and recipient = ? and hash = ? and created_at > ? limit 1",
        )
        .get(caller.address!, human!, hash, now - LIMITS.duplicateWindowMs);
      if (duplicate) throw new MailError(`Duplicate: you already sent ${human} this exact message (${duplicate.id}).`);
      const id = newId();
      db.query(
        `insert into messages (id, send_id, created_at, sender, sender_app, sender_ref, recipient, recipient_app, routed_from,
           kind, reply, ticket, summary, body, reply_to, thread_id, depth, forward_of, hash, state, wake_state, not_before)
         values (?, ?, ?, ?, ?, ?, ?, 'telegram', null, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', 'pending', ?)`,
      ).run(id, sendId, now, caller.address!, caller.app, caller.ref, human!, kind, input.reply, ticket, summary, body, parent?.id ?? null, threadId, depth, forwardOf?.id ?? null, hash, null);
      deliveries.push({
        id,
        to: human!,
        app: "telegram",
        outlook: `queued for ${human} on Telegram; actual delivery is shown in outbox`,
      });
    }
    for (const { agent, routedFrom } of resolved.values()) {
      const duplicate = db
        .query<{ id: string }, [string, string, string, number]>(
          "select id from messages where sender = ? and recipient = ? and hash = ? and created_at > ? limit 1",
        )
        .get(caller.address!, agent.address, hash, now - LIMITS.duplicateWindowMs);
      if (duplicate) throw new MailError(`Duplicate: you already sent ${agent.address} this exact message (${duplicate.id}).`);
      // Rate limits per rolling minute. Blockers and handoffs are never refused: over the limit they're
      // kept and woken once the window frees up.
      const windowStart = now - 60_000;
      const freeAt = (limit: number, recipientOnly: boolean) => {
        const row = recipientOnly
          ? db
              .query<{ created_at: number }, [string, string, number, number]>(
                "select created_at from messages where sender = ? and recipient = ? and created_at > ? order by created_at desc limit 1 offset ?",
              )
              .get(caller.address!, agent.address, windowStart, limit - 1)
          : db
              .query<{ created_at: number }, [string, number, number]>(
                "select created_at from messages where sender = ? and created_at > ? order by created_at desc limit 1 offset ?",
              )
              .get(caller.address!, windowStart, limit - 1);
        return row ? row.created_at + 60_000 : null;
      };
      const pairFree = freeAt(LIMITS.perPairPerMinute, true);
      const senderFree = freeAt(LIMITS.perSenderPerMinute, false);
      let notBefore: number | null = null;
      if (pairFree !== null || senderFree !== null) {
        const until = Math.max(pairFree ?? 0, senderFree ?? 0);
        if (!NEVER_REFUSED.has(kind)) {
          const which =
            senderFree !== null
              ? `${LIMITS.perSenderPerMinute} messages a minute from one chat`
              : `${LIMITS.perPairPerMinute} messages a minute to ${agent.address}`;
          throw new MailError(
            `Over the limit of ${which}; try again in ${Math.ceil((until - now) / 1000)} s, or batch it into one message. Blockers and handoffs are never refused; they're held and delivered when there's room.`,
          );
        }
        notBefore = until;
      }
      const minutes = cfg.coordinatorDigestMinutes;
      const routine = minutes > 0 && caller.role === "builder" && agent.role === "coordinator" && (kind === "handoff" || kind === "fyi");
      const digestAt = routine ? (Math.floor(now / (minutes * 60_000)) + 1) * minutes * 60_000 : null;
      if (digestAt !== null) notBefore = Math.max(notBefore ?? 0, digestAt);

      const id = newId();
      if (ticket) {
        const replaced = db
          .query(
            `update messages set state = 'superseded', superseded_by = ?,
               wake_state = case when wake_state in ('pending', 'failed', 'digest') then 'none' else wake_state end
             where sender = ? and recipient = ? and ticket = ? and kind = ? and state = 'unread'`,
          )
          .run(id, caller.address!, agent.address, ticket, kind);
        superseded += replaced.changes;
      }
      db.query(
        `insert into messages (id, send_id, created_at, sender, sender_app, sender_ref, recipient, recipient_app, routed_from,
           kind, reply, ticket, summary, body, reply_to, thread_id, depth, forward_of, hash, state, wake_state, not_before)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?, ?)`,
      ).run(
        id,
        sendId,
        now,
        caller.address!,
        caller.app,
        caller.ref,
        agent.address,
        agent.app,
        routedFrom ?? null,
        kind,
        input.reply,
        ticket,
        summary,
        body,
        parent?.id ?? null,
        threadId,
        depth,
        forwardOf?.id ?? null,
        hash,
        WAKING_KINDS.has(kind) ? "pending" : "digest",
        notBefore,
      );
      const held = digestAt !== null ? `queued for the routine coordinator digest at ${clock(notBefore!, cfg)}` : notBefore ? `held: you're over the rate limit, so it's delivered at ${clock(notBefore, cfg)} (blockers and handoffs are never dropped)` : null;
      const actual = db.query<{recipient:string;recipient_app:string},[string]>("select recipient,recipient_app from messages where id=?").get(id)!;
      const intake = actual.recipient !== agent.address;
      deliveries.push({ id, to: actual.recipient, app: actual.recipient_app, routedFrom: intake ? agent.address : routedFrom,
        outlook: intake ? `stored for Mail Operator routing; final delivery pending${held ? `; ${held}` : ""}` : held ?? outlook(agent, kind, cfg, live.has(agent.ref)) });
    }
  });
  write.immediate();
  logEvent(db, caller.address, "send", sendId, {
    kind,
    ticket,
    to: deliveries.map((d) => (d.routedFrom ? `${d.to} (for ${d.routedFrom})` : d.to)),
    ids: deliveries.map((d) => d.id),
    chars: summary.length + body.length,
    superseded,
  });
  return { sendId, deliveries, superseded };
}

function outlook(agent: Agent, kind: Kind, cfg: Config, mailLive: boolean): string {
  if (agent.manualInbox) return "stored for the recipient inbox; this launch persona uses manual inbox reads";
  if (!WAKING_KINDS.has(kind)) return `FYI: no wake-up; shown at its next inbox or the ${cfg.digestTimes.join("/")} digest`;
  if (agent.app === "codex")
    return agent.presence === "busy" ? "queued in Codex; it sees it after the current turn" : "waking via codex queue (its chat is opened in Codex if it isn't already)";
  if (agent.presence === "closed") return "chat is closed; it is woken when the chat reopens";
  if (!mailLive) return `its chat hasn't loaded ${mailName(cfg)} yet (it needs a restart); the mail waits until then`;
  return agent.presence === "busy" ? "it sees it after the current turn" : "waking now";
}

function visibleMessage(db: Database, address: string, id: string): MessageRow | null {
  return (
    db.query<MessageRow, [string, string, string]>("select * from messages where id = ? and (recipient = ? or sender = ?)").get(id.trim(), address, address) ?? null
  );
}

const KIND_ORDER: Record<Kind, number> = { blocker: 0, decision: 1, action: 2, handoff: 3, fyi: 4 };
const ONLY_HUMAN_NOTE = "Don't reply just to say thanks or received; use ack.";

export function clock(ms: number, cfg: Config): string {
  const now = Date.now();
  const sameDay = new Date(ms).toDateString() === new Date(now).toDateString();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: cfg.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
  });
  return `${fmt.format(ms)} ${cfg.timeZone}`;
}

function header(row: MessageRow, cfg: Config): string {
  const bits = [
    row.kind.toUpperCase(),
    row.reply === "required" ? "reply required" : null,
    row.ticket,
    row.sender_app === "telegram" ? `from ${humanLabel(cfg)}` : `from ${row.sender} (${row.sender_app === "claude" ? "Claude" : "Codex"})`,
    row.routed_from ? `addressed to ${row.routed_from}, routed to you` : null,
    clock(row.created_at, cfg),
  ].filter(Boolean);
  return `${row.id}  ${bits.join(" · ")}`;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

export function inbox(db: Database, cfg: Config, caller: Caller, limit = 10, now = Date.now()): string {
  if (!caller.address) throw new MailError(caller.problem ?? "This process has no configured Sideband identity.");
  const rows = db
    .query<MessageRow, [string]>("select * from messages where recipient = ? and state = 'unread' order by created_at asc")
    .all(caller.address);
  if (rows.length === 0) return `No unread mail for ${caller.address}.`;
  const actionable = rows.filter((r) => r.kind !== "fyi").sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.created_at - b.created_at);
  const shown = actionable.slice(0, limit);
  const fyiGroups = new Map<string, MessageRow[]>();
  for (const row of rows.filter((r) => r.kind === "fyi")) {
    const key = `${row.ticket ?? "-"}|${row.sender}`;
    fyiGroups.set(key, [...(fyiGroups.get(key) ?? []), row]);
  }
  const counts = KINDS.map((k) => [k, rows.filter((r) => r.kind === k).length] as const).filter(([, n]) => n > 0);
  const fromHuman = rows.filter((r) => r.sender_app === "telegram").length;
  const note = !fromHuman ? authorityNote(cfg) : fromHuman === rows.length ? `${verifiedNote(cfg)} ${ONLY_HUMAN_NOTE}` : `${verifiedNote(cfg)} ${authorityNote(cfg, true)}`;
  const lines = [`${mailName(cfg)} for ${caller.address}: ${rows.length} unread (${counts.map(([k, n]) => `${n} ${k}`).join(", ")}). ${note}`];
  const replaced = (id: string) =>
    db.query<{ id: string }, [string]>("select id from messages where superseded_by = ?").all(id).map((r) => r.id);
  for (const row of shown) {
    lines.push("", header(row, cfg), indent(row.summary));
    if (row.body) lines.push(indent(row.body));
    if (row.reply_to) lines.push(indent(`(reply to ${row.reply_to})`));
    const older = replaced(row.id);
    if (older.length) lines.push(indent(`(replaces ${older.length} earlier unread note${older.length > 1 ? "s" : ""}: ${older.join(", ")})`));
  }
  if (actionable.length > shown.length) lines.push("", `${actionable.length - shown.length} more actionable messages; call inbox again.`);
  if (fyiGroups.size) {
    lines.push("", "FYI, latest per ticket and sender:");
    for (const group of fyiGroups.values()) {
      const latest = group[group.length - 1]!;
      lines.push(`${header(latest, cfg)}${group.length > 1 ? ` (+${group.length - 1} older)` : ""}`, indent(latest.summary));
      if (latest.body) lines.push(indent(latest.body));
    }
  }
  const readIds = [...shown, ...[...fyiGroups.values()].flat()].map((r) => r.id);
  const mark = db.transaction(() => {
    for (const id of readIds) db.query("update messages set state = 'read', read_at = ? where id = ? and state = 'unread'").run(now, id);
  });
  mark.immediate();
  logEvent(db, caller.address, "read", null, { ids: readIds });
  return lines.join("\n");
}

export function readThread(db: Database, cfg: Config, caller: Caller, id: string, now = Date.now()): string {
  if (!caller.address) throw new MailError(caller.problem ?? "This process has no configured Sideband identity.");
  const row = visibleMessage(db, caller.address, id);
  if (!row) throw new MailError(`No message ${id} that you sent or received.`);
  const thread = db
    .query<MessageRow, [string, string, string]>(
      "select * from messages where thread_id = ? and (recipient = ? or sender = ?) order by created_at asc",
    )
    .all(row.thread_id, caller.address, caller.address);
  const lines = [`Thread ${row.thread_id} (${thread.length} message${thread.length > 1 ? "s" : ""}). ${authorityNote(cfg)}`];
  for (const m of thread) {
    lines.push("", `${header(m, cfg)} → ${m.recipient} · ${m.state}${m.ack_note ? ` (ack: ${m.ack_note})` : ""}`, indent(m.summary));
    if (m.body) lines.push(indent(m.body));
  }
  if (row.recipient === caller.address && row.state === "unread") {
    db.query("update messages set state = 'read', read_at = ? where id = ?").run(now, row.id);
    logEvent(db, caller.address, "read", null, { ids: [row.id] });
  }
  return lines.join("\n");
}

export function ack(db: Database, caller: Caller, id: string, note?: string, now = Date.now()): string {
  if (!caller.address) throw new MailError(caller.problem ?? "This process has no configured Sideband identity.");
  const text = clean(note);
  if (text.length > LIMITS.ackChars) throw new MailError(`An ack note is at most ${LIMITS.ackChars} characters.`);
  const row = db.query<MessageRow, [string, string]>("select * from messages where id = ? and recipient = ?").get(id.trim(), caller.address);
  if (!row) throw new MailError(`No message ${id} addressed to you.`);
  db.query("update messages set state = 'acked', acked_at = ?, ack_note = ?, read_at = coalesce(read_at, ?) where id = ?").run(
    now,
    text || null,
    now,
    row.id,
  );
  logEvent(db, caller.address, "ack", row.id, { note: text || null });
  return `Acknowledged ${row.id}. ${row.sender} sees it in outbox; nobody is woken.`;
}

export function outbox(db: Database, cfg: Config, caller: Caller, limit = 10): string {
  if (!caller.address) throw new MailError(caller.problem ?? "This process has no configured Sideband identity.");
  const rows = db
    .query<MessageRow, [string, number]>("select * from messages where sender = ? order by created_at desc limit ?")
    .all(caller.address, limit);
  if (rows.length === 0) return "You haven't sent any mail.";
  return rows
    .map((r) => {
      const wake =
        r.recipient_app === "telegram"
          ? { pending: "Telegram send pending", woken: "sent to Telegram", failed: "Telegram send failed, retrying", digest: "", digested: "", none: "not sent" }[r.wake_state]
          : { pending: "wake pending", woken: "woken", failed: "wake failed, retrying", digest: "FYI, awaiting digest", digested: "in digest", none: "not woken" }[r.wake_state];
      const status = r.state === "acked" ? `acked${r.ack_note ? `: ${r.ack_note}` : ""}` : r.state === "superseded" ? `replaced by ${r.superseded_by}` : r.state;
      return `${r.id} → ${r.recipient}${r.routed_from ? ` (for ${r.routed_from})` : ""} · ${r.kind} · ${clock(r.created_at, cfg)} · ${status} · ${wake}\n  ${r.summary}`;
    })
    .join("\n");
}

export function formatAgents(agents: Agent[], db: Database, cfg: Config, caller: Caller | null, now = Date.now()): string {
  const unread = new Map(
    db
      .query<{ recipient: string; n: number }, []>("select recipient, count(*) n from messages where state = 'unread' group by recipient")
      .all()
      .map((r) => [r.recipient, r.n]),
  );
  const live = liveMailRefs(db, now);
  const ago = (ms: number | null) => {
    if (!ms) return "never";
    const minutes = Math.round((now - ms) / 60_000);
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m ago`;
    if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;
    return `${Math.round(minutes / 1440)}d ago`;
  };
  const line = (a: Agent) => {
    const work = a.work === "free" ? "free" : a.work === "working" ? ["working", a.task, a.ticket].filter(Boolean).join(" · ") : a.role;
    const presence = a.app === "codex" ? (a.presence === "busy" ? "busy (mid-turn)" : a.presence) : a.presence === "closed" ? "closed" : `open, ${a.presence}`;
    const mailState =
      a.app === "claude" && a.presence !== "closed" && !live.has(a.ref) ? "mail not loaded, restart needed" : a.app === "codex" && live.has(a.ref) ? "mail loaded" : null;
    const extra = [
      unread.get(a.address) ? `${unread.get(a.address)} unread` : null,
      mailState,
      a.duplicates.length ? `${a.duplicates.length} other chat(s) share this title` : null,
    ]
      .filter(Boolean)
      .join(", ");
    return `  ${a.address.padEnd(28)} ${work.padEnd(52)} ${presence.padEnd(16)} ${ago(a.lastActive)}${extra ? ` · ${extra}` : ""}`;
  };
  const me = caller ? (caller.address ? `You are ${caller.address} (${caller.app === "claude" ? "Claude" : "Codex"}).` : `You have no address: ${caller.problem}`) : "";
  const section = (app: "claude" | "codex", label: string) => [label, ...agents.filter((a) => a.app === app).map(line)];
  return [
    me,
    "Launch personas show server connection, not model activity. Optional native bindings show host metadata; queue, read and completion remain separate.",
    ...section("claude", "Claude"),
    ...section("codex", "Codex"),
    humanAddress(cfg) ? `${humanAddress(cfg)}\n  ${humanAddress(cfg)!.padEnd(28)} ${(telegramConfigured(cfg) ? "on Telegram: results and real blockers only (no fyi)" : "Telegram not connected yet").padEnd(52)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
