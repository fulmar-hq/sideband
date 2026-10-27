// replies come back as mail from `the human`. Only messages whose chat id AND sender id equal
// TELEGRAM_CHAT_ID are accepted. That check is what lets a reply count as the human's own answer
// The bot token is read from telegram.env for each call and never logged, echoed or stored.
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { LIMITS, type Config } from "./config";
import type { Directory } from "./directory";
import { activeOperator } from "./operator";
import { humanAddress, operatorAddress } from "./context";
import { findSecret } from "./secrets";
import { logEvent, newId, sha256, type MessageRow } from "./store";


export const POLL_LEASE = "telegram-poll-v1";
/**
 * The poller's code version, kept in the lease holder ("host:pid#v3"). A server with newer poll code takes
 * the lease from an older holder, so a fix reaches the poller without restarting every chat. Bump it when
 * reply handling changes. Telegram allows one getUpdates at a time, so a brief overlap only fails one call.
 */
export const POLL_VERSION = 8;

/**
 * Takes a lease unless a holder with the same or newer code still has it. The version rides in the holder
 * ("host:pid#v4"); holders from code without a tag count as version 1, so a fix takes over from them.
 */
export function takeVersionedLease(db: Database, name: string, version: number, holder: string, ttlMs: number, now = Date.now()): boolean {
  const tag = `${holder}#v${version}`;
  const take = db.transaction(() => {
    const row = db.query<{ holder: string; expires_at: number }, [string]>("select holder, expires_at from leases where name = ?").get(name);
    const theirs = Number(row?.holder.match(/#v(\d+)$/)?.[1] ?? 1);
    if (row && row.holder !== tag && row.expires_at > now && theirs >= version) return false;
    db.query("insert into leases (name, holder, expires_at) values (?, ?, ?) on conflict(name) do update set holder = excluded.holder, expires_at = excluded.expires_at").run(
      name,
      tag,
      now + ttlMs,
    );
    return true;
  });
  return take.immediate();
}

export function takePollLease(db: Database, holder: string, now = Date.now(), version = POLL_VERSION): boolean {
  return takeVersionedLease(db, POLL_LEASE, version, holder, LIMITS.telegramPollLeaseMs, now);
}

/** Held continuously by the newest server, so an older one never sends a message in the old style. */
export function takeSendLease(db: Database, holder: string, now = Date.now()): boolean {
  return takeVersionedLease(db, SEND_LEASE, SEND_VERSION, holder, 20_000, now);
}
const SEND_LEASE = "telegram-send-v1";
/** Version of the code that writes the human's messages (the Telegram style). Newer takes the send lease from older. */
export const SEND_VERSION = 6;

export interface TelegramCreds {
  token: string;
  chatId: string;
}

/** Reads telegram.env (KEY=VALUE lines). Null when it's missing or incomplete. */
export function loadTelegram(cfg: Config): TelegramCreds | null {
  if (cfg.project && (!cfg.project.telegram || !cfg.project.human)) return null;
  if (!existsSync(cfg.telegramEnv)) return null;
  try {
    const values = new Map<string, string>();
    for (const line of readFileSync(cfg.telegramEnv, "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Z_]+)\s*=\s*['"]?([^'"\s]*)['"]?\s*$/);
      if (match) values.set(match[1]!, match[2]!);
    }
    const token = values.get("TELEGRAM_BOT_TOKEN") ?? "";
    const chatId = values.get("TELEGRAM_CHAT_ID") ?? "";
    return token.includes(":") && /^-?\d+$/.test(chatId) ? { token, chatId } : null;
  } catch {
    return null;
  }
}

export function telegramConfigured(cfg: Config): boolean {
  return loadTelegram(cfg) !== null;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat?: { id: number | string };
    from?: { id: number | string; is_bot?: boolean };
    text?: string;
    reply_to_message?: { message_id: number };
  };
}

/** The two Bot API calls we use; tests pass a fake. */
export interface TelegramApi {
  sendMessage(text: string, replyTo?: number): Promise<{ ok: true; messageId: number } | { ok: false; detail: string }>;
  getUpdates(offset: number, timeoutSeconds: number): Promise<{ ok: true; updates: TelegramUpdate[] } | { ok: false; detail: string }>;
  /** A reaction on one of the human's messages: how he sees that it went through. */
  react(messageId: number, emoji: string): Promise<{ ok: true } | { ok: false; detail: string }>;
}

/** The real Bot API. Any error text has the token removed before it goes anywhere. */
export function botApi(cfg: Config, creds: TelegramCreds): TelegramApi {
  const scrub = (text: string) => text.split(creds.token).join("<token>").slice(0, 200);
  const call = async (method: string, params: Record<string, unknown>, timeoutMs: number) => {
    try {
      const response = await fetch(`${cfg.telegramApi}/bot${creds.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = (await response.json()) as { ok: boolean; result?: unknown; description?: string };
      return data.ok ? { ok: true as const, result: data.result } : { ok: false as const, detail: scrub(`${response.status} ${data.description ?? ""}`) };
    } catch (error) {
      return { ok: false as const, detail: scrub((error as Error).message ?? "request failed") };
    }
  };
  return {
    async sendMessage(text, replyTo) {
      const result = await call(
        "sendMessage",
        { chat_id: creds.chatId, text, ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) },
        15_000,
      );
      return result.ok ? { ok: true, messageId: (result.result as { message_id: number }).message_id } : result;
    },
    async react(messageId, emoji) {
      const result = await call("setMessageReaction", { chat_id: creds.chatId, message_id: messageId, reaction: [{ type: "emoji", emoji }] }, 10_000);
      return result.ok ? { ok: true } : result;
    },
    async getUpdates(offset, timeoutSeconds) {
      const result = await call("getUpdates", { offset, timeout: timeoutSeconds, allowed_updates: ["message"] }, (timeoutSeconds + 10) * 1000);
      return result.ok ? { ok: true, updates: result.result as TelegramUpdate[] } : result;
    },
  };
}


export function plainName(address: string): string { return address; }


export function formatForTelegram(row: MessageRow, cfg: Config): string {
  const summary = row.summary.trim();
  const body = (row.body ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const point = row.sender === operatorAddress(cfg) ? summary : `${row.sender}: ${summary}`;
  return body ? `${point}\n\n${body}` : point;
}

/** Sends due mail for the human, one Telegram message each, and remembers which Telegram message carried which mail. */
export async function deliverToHuman(db: Database, cfg: Config, holder: string, now = Date.now(), api?: TelegramApi): Promise<number> {
  const due = db
    .query<MessageRow, [number]>(
      "select * from messages where recipient_app = 'telegram' and state = 'unread' and wake_state in ('pending', 'failed') and coalesce(not_before, 0) <= ? order by created_at asc",
    )
    .all(now);
  if (due.length === 0) return 0;
  const creds = loadTelegram(cfg);
  if (!creds) return 0;
  if (!takeSendLease(db, holder, now)) return 0;
  const client = api ?? botApi(cfg, creds);
  let sent = 0;
  for (const row of due) {
    if (row.wake_state === "failed") {
      const lastTry = db.query<{ at: number }, [string, string]>("select max(at) at from wakes where recipient = ? and message_ids like ?").get(humanAddress(cfg)!, `%${row.id}%`)?.at;
      if (lastTry && now - lastTry < LIMITS.telegramRetryMs) continue;
    }
    const wakeId = newId("w");
    const claimed = db.query("update messages set wake_state = 'woken', wake_id = ? where id = ? and wake_state in ('pending', 'failed')").run(wakeId, row.id).changes;
    if (!claimed) continue;
    const result = await client.sendMessage(formatForTelegram(row, cfg));
    const record = db.transaction(() => {
      if (result.ok) {
        db.query("insert or replace into telegram_messages (message_id, mail_id, sent_at) values (?, ?, ?)").run(result.messageId, row.id, now);
      } else {
        db.query("update messages set wake_state = 'failed' where id = ? and wake_id = ?").run(row.id, wakeId);
      }
      db.query("insert into wakes (id, at, recipient, app, method, message_ids, ok, detail) values (?, ?, ?, 'telegram', 'telegram-send', ?, ?, ?)").run(
        wakeId,
        now,
        humanAddress(cfg)!,
        JSON.stringify([row.id]),
        result.ok ? 1 : 0,
        result.ok ? `telegram message ${result.messageId}` : result.detail,
      );
    });
    record.immediate();
    logEvent(db, "sideband", result.ok ? "telegram-sent" : "telegram-send-failed", wakeId, {
      mail: row.id,
      ...(result.ok ? { telegramMessage: result.messageId } : { detail: result.detail }),
    });
    if (result.ok) sent += 1;
  }
  return sent;
}

/** Mail to the human from the last day that asked for a reply and hasn't had one, newest first. */

function offset(db: Database): number {
  return Number(db.query<{ value: string }, []>("select value from telegram_state where key = 'offset'").get()?.value ?? 0);
}

/** The rare note back to the human, in plain words: why something didn't go through. */
function refusalText(reason: string): string {
  if (/looks like it contains/.test(reason)) return "I didn't pass that on: it looked like a password or key. Could you send it without that?";
  if (/only text/.test(reason)) return "Only text comes through here, sorry.";
  if (/no Coordinator/.test(reason)) return "Nobody's around to take that right now. I'll keep it out of the way; try again a bit later.";
  return `I couldn't pass that on (${reason}).`;
}

/** A short message back to the human in Telegram, threaded under his. */
async function notice(client: TelegramApi, text: string, replyTo: number) {
  await client.sendMessage(text, replyTo);
}

/**
 * Turns one update into mail, or drops it. Everything that changes the store for this update, including
 * the next offset, happens in one transaction, so a crash can't lose or double a reply.
 */
export function acceptUpdate(
  db: Database,
  creds: TelegramCreds,
  directory: Directory,
  update: TelegramUpdate,
  now = Date.now(),
): { outcome: "delivered"; mailId: string; to: string; replyTo: number; parentId: string | null; note?: string } | { outcome: "dropped" | "refused" | "ignored"; reason: string; replyTo?: number } {
  const principal = directory.humanAddress();
  if (!principal) return { outcome: "refused", reason: "No human recipient is configured" };
  const message = update.message;
  type Result = ReturnType<typeof acceptUpdate>;
  let insert: (() => void) | null = null;
  let result: Result;
  if (!message) {
    result = { outcome: "ignored", reason: "not a message" };
  } else if (String(message.chat?.id) !== creds.chatId || String(message.from?.id) !== creds.chatId || message.from?.is_bot) {
    // Only the human's own private chat with the bot. Log ids, never the text.
    result = { outcome: "dropped", reason: `unverified sender (chat ${message.chat?.id ?? "?"}, from ${message.from?.id ?? "?"})` };
  } else if (/^\/start(?:@\w+)?(?:\s|$)/i.test(message.text?.trim() ?? "")) {
    // Telegram sends /start when a chat with the bot is first opened; it isn't a message for anyone.
    result = { outcome: "ignored", reason: "bot start command" };
  } else if (!message.text?.trim()) {
    result = { outcome: "refused", reason: "only text replies are delivered", replyTo: message.message_id };
  } else {
    const text = message.text.replace(/\r\n/g, "\n").trim();
    const secret = findSecret(text);
    const repliedTo = message.reply_to_message?.message_id;
    const mapped = repliedTo ? db.query<{ mail_id: string }, [number]>("select mail_id from telegram_messages where message_id = ?").get(repliedTo) : null;
    let parent = mapped ? db.query<MessageRow, [string]>("select * from messages where id = ?").get(mapped.mail_id) : null;
    // Explicit Telegram reply context is retained; an unthreaded message never guesses a waiting owner.
    activeOperator(db, directory); // Validate active registration; store trigger retains intended owner.
    const coordinator = parent ? null : directory.coordinator("claude");
    const to = parent ? { address: parent.sender, app: parent.sender_app } : coordinator;
    if (secret) {
      result = { outcome: "refused", reason: `it looks like it contains ${secret}`, replyTo: message.message_id };
    } else if (!to) {
      result = { outcome: "refused", reason: "no Coordinator chat was found to deliver it to", replyTo: message.message_id };
    } else {
      const firstLine = text.split("\n")[0]!.trim();
      const summary = firstLine.length > LIMITS.summaryChars ? `${firstLine.slice(0, LIMITS.summaryChars - 1)}…` : firstLine;
      const rest = text.length > summary.length ? text : "";
      const body = rest.length > LIMITS.bodyChars ? `${rest.slice(0, LIMITS.bodyChars - 40)}… (full text in Telegram)` : rest;
      const mailId = newId();
      const sendId = newId("s");
      insert = () =>
        db
          .query(
            `insert into messages (id, send_id, created_at, sender, sender_app, sender_ref, recipient, recipient_app, routed_from,
               kind, reply, ticket, summary, body, reply_to, thread_id, depth, forward_of, hash, state, wake_state, not_before)
             values (?, ?, ?, ?, 'telegram', ?, ?, ?, null, 'action', 'none', ?, ?, ?, ?, ?, ?, null, ?, 'unread', 'pending', null)`,
          )
          .run(
            mailId,
            sendId,
            now,
            principal,
            `telegram:${message.message_id}`,
            to.address,
            to.app,
            parent?.ticket ?? null,
            summary,
            body,
            parent?.id ?? null,
            parent?.thread_id ?? sendId,
            parent ? parent.depth + 1 : 0,
            sha256(["action", parent?.ticket ?? "", summary, body].join("\u001f")),
          );
      result = { outcome: "delivered", mailId, to: to.address, replyTo: message.message_id, parentId: parent?.id ?? null };
    }
  }
  // The mail and the next offset are written together, so a crash can't lose or double a reply.
  const write = db.transaction(() => {
    // Recheck inside the same write lock: overlapping long polls cannot duplicate a verified root.
    if (insert && message && db.query("select id from messages where sender_app='telegram' and sender_ref=? and forward_of is null").get(`telegram:${message.message_id}`)) {
      insert = null;
      result = {outcome:"ignored",reason:"Telegram message already accepted"};
    }
    insert?.();
    if (result.outcome === "delivered") {
      const actual = db.query<{recipient:string},[string]>("select recipient from messages where id=?").get(result.mailId);
      if (actual) result.to=actual.recipient;
    }
    // The mail the human answered is done: it no longer counts as waiting on him.
    if (insert && result.outcome === "delivered" && result.parentId)
      db.query("update messages set state = 'acked', acked_at = ?, ack_note = 'the human replied in Telegram' where id = ? and state = 'unread'").run(now, result.parentId);
    db.query("insert into telegram_state (key, value) values ('offset', ?) on conflict(key) do update set value = excluded.value").run(
      String(update.update_id + 1),
    );
  });
  write.immediate();
  return result;
}

/** One getUpdates round by the lease holder. Returns how many replies became mail, or null when this server didn't poll (no setup, another holder, or an error). */
export async function pollHuman(db: Database, cfg: Config, directory: Directory, holder: string, waitSeconds: number = LIMITS.telegramPollSeconds, now = () => Date.now(), api?: TelegramApi, version = POLL_VERSION): Promise<number | null> {
  const creds = loadTelegram(cfg);
  if (!creds) return null;
  if (!takePollLease(db, holder, now(), version)) return null;
  const client = api ?? botApi(cfg, creds);
  const response = await client.getUpdates(offset(db), waitSeconds);
  if (!response.ok) {
    logEvent(db, "sideband", "telegram-poll-failed", null, { detail: response.detail });
    return null;
  }
  let delivered = 0;
  for (const update of response.updates.sort((a, b) => a.update_id - b.update_id)) {
    if (update.update_id < offset(db)) continue;
    const result = acceptUpdate(db, creds, directory, update, now());
    if (result.outcome === "delivered") {
      delivered += 1;
      logEvent(db, humanAddress(cfg)!, "telegram-reply", result.mailId, { to: result.to, update: update.update_id });
      const reacted = await client.react(result.replyTo, "👍");
      if (!reacted.ok) logEvent(db, "sideband", "telegram-react-failed", result.mailId, { detail: reacted.detail });
    } else if (result.outcome === "refused") {
      logEvent(db, "sideband", "telegram-refused", null, { update: update.update_id, reason: result.reason });
      if (result.replyTo) await notice(client, refusalText(result.reason), result.replyTo);
    } else if (result.outcome === "dropped") {
      logEvent(db, "sideband", "telegram-dropped", null, { update: update.update_id, reason: result.reason });
    }
  }
  return delivered;
}

export function telegramStatus(db: Database, cfg: Config, now = Date.now()): string {
  const creds = loadTelegram(cfg);
  const lease = db.query<{ holder: string; expires_at: number }, [string]>("select holder, expires_at from leases where name = ?").get(POLL_LEASE);
  const last = (type: string) => db.query<{ at: number; detail: string }, [string]>("select at, detail from events where type = ? order by seq desc limit 1").get(type);
  const sent = last("telegram-sent");
  const reply = last("telegram-reply");
  const failed = last("telegram-poll-failed");
  const ago = (at?: number) => (at ? `${Math.round((now - at) / 60_000)} min ago` : "never");
  return [
    `Telegram: ${creds ? `connected (chat id ends …${creds.chatId.slice(-3)})` : `not set up (${cfg.telegramEnv} missing or incomplete)`}`,
    `Poller: ${lease && lease.expires_at > now ? `held by ${lease.holder}` : "no server holds the poll lease right now"}; offset ${offset(db)}`,
    `Last sent to ${humanAddress(cfg) ?? "the human"}: ${ago(sent?.at)}. Last reply from ${humanAddress(cfg) ?? "the human"}: ${ago(reply?.at)}. Last poll failure: ${failed ? `${ago(failed.at)} (${JSON.parse(failed.detail).detail})` : "none"}.`,
  ].join("\n");
}
