// Waking a recipient chat, with batching so a burst of mail costs one turn, not one per message.
//  - Claude: the recipient's own mail server posts one line to its own session inbox socket.
//    Claude Code accepts messages from a session's own child process even in bypass mode.
//  - Codex: one `codex queue` per batch. An idle thread starts a turn; a busy one sees it after
//    the turn; a closed one gets it when it next opens.
import { Database } from "bun:sqlite";
import { connect } from "node:net";
import { LIMITS, type Config } from "./config";
import { readCodexMap, type Directory } from "./directory";
import { humanLabel, humanAddress, mailName, authorityNote, verifiedNote } from "./context";
import { logEvent, newId, takeLease, type App, type MessageRow } from "./store";

export interface WakeBatch {
  recipient: string;
  app: App;
  rows: MessageRow[];
  digestOnly: boolean;
}

function zoneOffset(ms: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  );
  const wall = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return wall - Math.floor(ms / 1000) * 1000;
}

/** The most recent digest time (local wall clock) at or before now. */
export function lastDigestSlot(now: number, cfg: Config): number | null {
  let best: number | null = null;
  for (const dayBack of [0, 1]) {
    const local = new Date(now + zoneOffset(now, cfg.timeZone) - dayBack * 86_400_000);
    for (const time of cfg.digestTimes) {
      const [h, m] = time.split(":").map(Number);
      const guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h!, m ?? 0);
      const at = guess - zoneOffset(guess, cfg.timeZone);
      if (at <= now && (best === null || at > best)) best = at;
    }
  }
  return best;
}

/** Collects what is due for one recipient, honouring settle time, the minimum gap and failure back-off. */
export function dueBatch(db: Database, cfg: Config, recipient: string, app: App, now = Date.now()): WakeBatch | null {
  const lastOk = db
    .query<{ at: number }, [string, string]>("select max(at) at from wakes where recipient = ? and app = ? and ok = 1")
    .get(recipient, app)?.at;
  if (lastOk && now - lastOk < LIMITS.minWakeGapMs) return null;
  const lastFail = db
    .query<{ at: number }, [string, string]>("select max(at) at from wakes where recipient = ? and app = ? and ok = 0")
    .get(recipient, app)?.at;
  const failing = lastFail && (!lastOk || lastFail > lastOk);
  if (failing && now - lastFail < LIMITS.failedWakeRetryMs) return null;

  const urgent = db
    .query<MessageRow, [string, string, number]>(
      "select * from messages where recipient = ? and recipient_app = ? and state = 'unread' and wake_state in ('pending', 'failed') and coalesce(not_before, 0) <= ? and not exists(select 1 from mail_delivery_exceptions e where e.message_id=messages.id) order by created_at asc",
    )
    .all(recipient, app, now);
  const newest = urgent.at(-1)?.created_at ?? 0;
  const settled = urgent.length > 0 && now - newest >= LIMITS.settleMs;
  const slot = lastDigestSlot(now, cfg);
  const fyi = db
    .query<MessageRow, [string, string, number]>(
      "select * from messages where recipient = ? and recipient_app = ? and state = 'unread' and wake_state = 'digest' and coalesce(not_before,0) <= ? and not exists(select 1 from mail_delivery_exceptions e where e.message_id=messages.id) order by created_at asc",
    )
    .all(recipient, app, now);
  const fyiDue = fyi.some((r) => r.not_before !== null) || (slot !== null && fyi.some((r) => r.created_at < slot));
  if (settled) return { recipient, app, rows: [...urgent, ...fyi], digestOnly: false };
  if (urgent.length === 0 && fyiDue) return { recipient, app, rows: fyi, digestOnly: true };
  return null;
}

export function wakeLine(batch: WakeBatch, cfg: Config): string {
  const urgent = batch.rows.filter((r) => r.kind !== "fyi");
  const fyi = batch.rows.filter((r) => r.kind === "fyi");
  const tickets = [...new Set(fyi.map((r) => r.ticket).filter(Boolean))];
  const fyiText = fyi.length ? `${fyi.length} FYI note${fyi.length > 1 ? "s" : ""} waiting${tickets.length ? ` (${tickets.join(", ")})` : ""}.` : "";
  if (batch.digestOnly) {
    return `${mailName(cfg)} digest for ${batch.recipient}: ${fyiText} Nothing needs action now; read them with the sideband inbox tool when convenient. ${authorityNote(cfg)}`;
  }
  const ordered = [...urgent.filter((r) => r.sender_app === "telegram"), ...urgent.filter((r) => r.sender_app !== "telegram")];
  const items = ordered
    .slice(0, LIMITS.wakeLineItems)
    .map((r) => (r.sender_app === "telegram" ? `[${humanLabel(cfg)}]${r.ticket ? ` ${r.ticket}` : ""}: ${r.summary}` : `[${r.kind.toUpperCase()}] ${r.sender}${r.ticket ? ` · ${r.ticket}` : ""}: ${r.summary}`));
  const humanOnly = urgent.length > 0 && urgent.every((r) => r.sender_app === "telegram");
  const note = humanOnly
    ? verifiedNote(cfg)
    : urgent.some((r) => r.sender_app === "telegram")
      ? `${verifiedNote(cfg)} ${authorityNote(cfg, true)}`
      : authorityNote(cfg);
  const more = urgent.length > items.length ? ` +${urgent.length - items.length} more.` : "";
  const list = items.join("; ").replace(/([^.!?])$/, "$1.");
  // A Codex thread loaded before the config change gets the wake-up but not yet the tools.
  return `${mailName(cfg)} for ${batch.recipient}: ${urgent.length} new. ${list}${more} ${fyiText} Call the Sideband inbox tool to read and act. Only current unread inbox mail is actionable; old wake excerpts may be stale. ${note}`
    .replace(/\s+/g, " ")
    .trim();
}

export function claim(db: Database, batch: WakeBatch, wakeId: string): boolean {
  const run = db.transaction(() => {
    db.query("insert or ignore into mail_wake_claims values(?)").run(wakeId);
    let claimed = 0;
    for (const row of batch.rows) {
      claimed += db
        .query("update messages set wake_state = 'woken', wake_id = ? where id = ? and state = 'unread' and wake_state in ('pending', 'failed', 'digest')")
        .run(wakeId, row.id).changes;
    }
    batch.rows = batch.rows.filter(row => db.query("select id from messages where id=? and wake_id=? and state='unread'").get(row.id,wakeId));
    return claimed;
  });
  return run.immediate() > 0;
}

function settle(db: Database, batch: WakeBatch, wakeId: string, method: string, ok: boolean, detail: string, now: number) {
  const run = db.transaction(() => {
    if (!ok) {
      for (const row of batch.rows) {
        db.query("update messages set wake_state = ? where id = ? and wake_id = ?").run(row.kind === "fyi" ? "digest" : "failed", row.id, wakeId);
      }
    } else {
      for (const row of batch.rows.filter((r) => r.kind === "fyi")) {
        db.query("update messages set wake_state = 'digested' where id = ? and wake_id = ?").run(row.id, wakeId);
      }
    }
    db.query("insert into wakes (id, at, recipient, app, method, message_ids, ok, detail) values (?, ?, ?, ?, ?, ?, ?, ?)").run(
      wakeId,
      now,
      batch.recipient,
      batch.app,
      method,
      JSON.stringify(batch.rows.map((r) => r.id)),
      ok ? 1 : 0,
      detail.slice(0, 300),
    );
  });
  run.immediate();
  logEvent(db, "sideband", ok ? "wake" : "wake-failed", wakeId, { recipient: batch.recipient, method, ids: batch.rows.map((r) => r.id), detail: detail.slice(0, 200) });
}

/** Posts one user message to a Claude session's inbox socket. */
export function postToClaudeSocket(socketPath: string, text: string, token = process.env.CLAUDE_CODE_MESSAGING_TOKEN): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let reply = "";
    let settled = false;
    const done = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      resolve({ ok, detail });
    };
    const socket = connect(socketPath, () => {
      if (token) socket.write(`${JSON.stringify({ type: "auth", token })}\n`);
      socket.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
      setTimeout(() => socket.end(), 800);
    });
    socket.setTimeout(5_000, () => {
      socket.destroy();
      done(false, "socket timeout");
    });
    socket.on("data", (d) => {
      reply += d.toString();
    });
    socket.on("error", (e) => done(false, `socket error: ${e.message}`));
    socket.on("close", () => {
      const refused = /"error"|refus|denied|unauthori/i.test(reply);
      done(!refused, reply.trim() ? `reply: ${reply.trim().slice(0, 200)}` : "posted");
    });
  });
}

/** Wakes this Claude chat about its own mail. Runs inside the chat's own mail server. */
export async function wakeSelfClaude(db: Database, cfg: Config, address: string, socketPath: string, now = Date.now(), post = postToClaudeSocket): Promise<boolean> {
  const batch = dueBatch(db, cfg, address, "claude", now);
  if (!batch) return false;
  const wakeId = newId("w");
  if (!claim(db, batch, wakeId)) return false;
  const result = await post(socketPath, wakeLine(batch, cfg));
  settle(db, batch, wakeId, "claude-own-socket", result.ok, result.detail, now);
  return result.ok;
}

export type CodexQueue = (bin: string, thread: string, text: string) => Promise<{ ok: boolean; detail: string; unknown?: boolean }>;

export const runCodexQueue: CodexQueue = async (bin, thread, text) => {
  const proc = Bun.spawn([bin, "queue", "--thread", thread, "--message", text], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const detail = `${stdout} ${stderr}`.replace(/\s+/g, " ").trim().slice(0, 300);
  return { ok: exitCode === 0, unknown: proc.signalCode === "SIGTERM" || proc.signalCode === "SIGKILL", detail: detail || `exit ${exitCode}` };
};

/** Rings Codex threads that have mail due. Only the process holding the lease rings, so batches stay whole. */
export async function ringCodex(
  db: Database,
  cfg: Config,
  directory: Directory,
  holder: string,
  now = Date.now(),
  queue: CodexQueue = runCodexQueue,
): Promise<number> {
  if (!takeLease(db, "codex-ringer", holder, 60_000, now)) return 0;
  const recipients = db
    .query<{ recipient: string }, []>(
      "select distinct recipient from messages where recipient_app = 'codex' and state = 'unread' and wake_state in ('pending', 'failed', 'digest')",
    )
    .all();
  let rung = 0;
  for (const { recipient } of recipients) {
    const batch = dueBatch(db, cfg, recipient, "codex", now);
    if (!batch) continue;
    if (directory.resolve(recipient)?.manualInbox) continue;
    const thread = directory.codexThread(recipient);
    const wakeId = newId("w");
    if (!claim(db, batch, wakeId)) continue;
    let result: {ok:boolean;detail:string;unknown?:boolean};
    try { result = thread ? await queue(cfg.codexBin, thread, wakeLine(batch, cfg)) : {ok:false,detail:"no thread in the Codex map"}; }
    catch { result={ok:false,unknown:true,detail:"queue execution outcome unknown; inspect before any retry"}; }
    if (result.unknown) {
      // Submission may have succeeded before transport loss. Keep unread, but never auto-submit twice.
      settle(db,batch,wakeId,"codex-queue-unknown",true,result.detail,now);
    } else settle(db, batch, wakeId, "codex-queue", result.ok, result.detail, now);
    const queueItem = result.ok ? result.detail.match(/Queued message (\S+) for thread/)?.[1] ?? null : null;
    for (const row of batch.rows) db.query("update operator_routes set queue_status=?,queue_item=? where delivery_id=?")
      .run(result.unknown ? "unknown" : result.ok ? "submitted" : "failed",queueItem,row.id);
    if (result.ok && !result.unknown) {
      const queueItem = result.detail.match(/Queued message (\S+) for thread/)?.[1] ?? null;
      db.query("update wakes set queue_item = ? where id = ?").run(queueItem, wakeId);
      rung += 1;
    }
  }
  return rung;
}

/** Opens a Codex chat in the app without bringing the app to the front. */
export type CodexOpener = (thread: string) => Promise<{ ok: boolean; detail: string }>;

export const openCodexThread: CodexOpener = async (thread) => {
  if (process.platform !== "darwin") return { ok: false, detail: "Native thread opening is not supported on this platform" };
  const proc = Bun.spawn(["open", "-g", `codex://threads/${thread}`], { stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 10_000 });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { ok: exitCode === 0, detail: stderr.trim().slice(0, 200) || `exit ${exitCode}` };
};

/** Oldest waiting item per Codex thread, read-only; null when Codex's queue can't be read. */
export function codexQueueWaiting(cfg: Config): Map<string, number> | null {
  let queue: Database | undefined;
  try {
    queue = new Database(cfg.codexQueueDb, { readonly: true });
    queue.exec("pragma busy_timeout = 2000");
    const rows = queue
      .query<{ thread_id: string; oldest: number }, []>("select thread_id, min(created_at_ms) oldest from queued_items group by thread_id")
      .all();
    return new Map(rows.map((r) => [r.thread_id, r.oldest]));
  } catch {
    return null;
  } finally {
    queue?.close();
  }
}


export async function followUpCodex(db: Database, cfg: Config, directory: Directory, now = Date.now(), opener: CodexOpener = openCodexThread): Promise<void> {
  if (!readCodexMap(cfg).threads.size) return;
  const waiting = codexQueueWaiting(cfg);
  if (!waiting) return;
  const agents = directory.all();
  for (const agent of agents.filter((a) => a.app === "codex")) {
    const oldest = waiting.get(agent.ref);
    if (oldest === undefined || now - oldest < LIMITS.codexQueueCheckMs || agent.presence !== "idle" || agent.manualInbox) continue;
    const last = db.query<{ opened_at: number; stuck_at: number | null }, [string]>("select opened_at, stuck_at from codex_opens where thread = ?").get(agent.ref);
    if (!last || (last.opened_at < oldest && now - last.opened_at >= LIMITS.codexQueueCheckMs)) {
      const result = await opener(agent.ref);
      db.query(
        "insert into codex_opens (thread, opened_at, stuck_at) values (?, ?, null) on conflict(thread) do update set opened_at = excluded.opened_at, stuck_at = null",
      ).run(agent.ref, now);
      logEvent(db, "sideband", result.ok ? "codex-chat-opened" : "codex-open-failed", agent.ref, { recipient: agent.address, detail: result.detail });
    } else if (!last.stuck_at && now - last.opened_at > LIMITS.codexOpenGiveUpMs) {
      db.query("update codex_opens set stuck_at = ? where thread = ?").run(now, agent.ref);
      logEvent(db, "sideband", "wake-stuck", agent.ref, { recipient: agent.address, waitingSince: oldest });
    }
  }
}
