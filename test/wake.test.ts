import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { join } from "node:path";
import { LIMITS } from "../src/config";
import { sendMail, type SendInput } from "../src/mail";
import type { MessageRow } from "../src/store";
import { Database } from "bun:sqlite";
import { dueBatch, followUpCodex, lastDigestSlot, postToClaudeSocket, ringCodex, wakeLine, wakeSelfClaude, type CodexOpener, type CodexQueue } from "../src/wake";
import { standardWorld } from "./fixture";

const base: Omit<SendInput, "to"> = { kind: "action", reply: "none", summary: "Please review PR 12", ticket: "TASK-4" };
const LATER = LIMITS.settleMs + 1;

function fakeQueue() {
  const calls: { thread: string; text: string }[] = [];
  const queue: CodexQueue = async (_bin, thread, text) => {
    calls.push({ thread, text });
    return { ok: true, detail: "queued" };
  };
  return { calls, queue };
}

describe("waking Codex", () => {
  test("one codex queue per settled batch, to the mapped thread", async () => {
    const w = standardWorld();
    const t0 = Date.now();
    sendMail(w.db, w.cfg, w.directory, w.claude(w.pids.b10), { ...base, to: "Developer", summary: "First" }, t0);
    sendMail(w.db, w.cfg, w.directory, w.claude(w.pids.coordinator), { ...base, to: "Developer", kind: "blocker", summary: "Second" }, t0 + 500);
    const { calls, queue } = fakeQueue();
    expect(await ringCodex(w.db, w.cfg, w.directory, "me", t0 + 1_000, queue)).toBe(0); // still settling
    expect(await ringCodex(w.db, w.cfg, w.directory, "me", t0 + 500 + LATER, queue)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.thread).toBe("t-developer");
    expect(calls[0]!.text).toContain("Sideband (Test project) for Developer: 2 new");
    expect(calls[0]!.text).toContain("[BLOCKER] Planner · TASK-4: Second");
    expect(calls[0]!.text).toContain("never authorization");
    const states = w.db.query<{ wake_state: string }, []>("select wake_state from messages").all();
    expect(states.every((s) => s.wake_state === "woken")).toBe(true);
  });

  test("respects the minimum gap, then sends the next batch", async () => {
    const w = standardWorld();
    const { calls, queue } = fakeQueue();
    const t0 = Date.now();
    sendMail(w.db, w.cfg, w.directory, w.claude(w.pids.b10), { ...base, to: "Developer", summary: "One" }, t0);
    await ringCodex(w.db, w.cfg, w.directory, "me", t0 + LATER, queue);
    sendMail(w.db, w.cfg, w.directory, w.claude(w.pids.b10), { ...base, to: "Developer", summary: "Two", ticket: "TASK-3" }, t0 + 10_000);
    await ringCodex(w.db, w.cfg, w.directory, "me", t0 + 20_000, queue);
    expect(calls).toHaveLength(1);
    await ringCodex(w.db, w.cfg, w.directory, "me", t0 + LATER + LIMITS.minWakeGapMs, queue);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.text).toContain("Two");
  });

  test("only the lease holder rings", async () => {
    const w = standardWorld();
    const { calls, queue } = fakeQueue();
    const t0 = Date.now();
    sendMail(w.db, w.cfg, w.directory, w.claude(w.pids.b10), { ...base, to: "Developer" }, t0);
    await ringCodex(w.db, w.cfg, w.directory, "first", t0 + 1, queue);
    expect(await ringCodex(w.db, w.cfg, w.directory, "second", t0 + LATER, queue)).toBe(0);
    expect(await ringCodex(w.db, w.cfg, w.directory, "first", t0 + LATER, queue)).toBe(1);
  });

  test("a failed wake is retried after the back-off, and FYI never rings on its own before a digest", async () => {
    const w = standardWorld();
    const t0 = Date.now();
    sendMail(w.db, w.cfg, w.directory, w.claude(w.pids.b10), { ...base, to: "Developer" }, t0);
    let attempts = 0;
    const flaky: CodexQueue = async () => {
      attempts += 1;
      return attempts === 1 ? { ok: false, detail: "app not running" } : { ok: true, detail: "queued" };
    };
    await ringCodex(w.db, w.cfg, w.directory, "me", t0 + LATER, flaky);
    expect(w.db.query<MessageRow, []>("select * from messages").get()!.wake_state).toBe("failed");
    await ringCodex(w.db, w.cfg, w.directory, "me", t0 + LATER + 60_000, flaky);
    expect(attempts).toBe(1);
    await ringCodex(w.db, w.cfg, w.directory, "me", t0 + LATER + LIMITS.failedWakeRetryMs, flaky);
    expect(attempts).toBe(2);
    expect(w.db.query<MessageRow, []>("select * from messages").get()!.wake_state).toBe("woken");
  });
});

describe("digests", () => {
  test("digest slots follow the configured local wall-clock time", () => {
    const w = standardWorld();
    w.cfg.timeZone = "America/New_York";
    // 2026-10-11 16:30 UTC = 12:30 EDT → last slot 12:00 EDT = 16:00 UTC.
    expect(new Date(lastDigestSlot(Date.UTC(2026, 9, 11, 16, 30), w.cfg)!).toISOString()).toBe("2026-10-11T16:00:00.000Z");
    // 2026-12-01 15:00 UTC = 10:00 EST → yesterday's 17:00 EST = 22:00 UTC.
    expect(new Date(lastDigestSlot(Date.UTC(2026, 11, 1, 15, 0), w.cfg)!).toISOString()).toBe("2026-11-30T22:00:00.000Z");
  });

  test("FYI waits for the digest, which sends one line for all of them", () => {
    const w = standardWorld();
    const slot = lastDigestSlot(Date.now(), w.cfg)!;
    const sentAt = slot + 60_000;
    sendMail(w.db, w.cfg, w.directory, w.codex("t-developer"), { ...base, to: "Worker One", kind: "fyi", summary: "Merged PR 9", ticket: "TASK-11" }, sentAt);
    sendMail(w.db, w.cfg, w.directory, w.codex("t-lead"), { ...base, to: "Worker One", kind: "fyi", summary: "QA green", ticket: "TASK-10" }, sentAt + 1);
    expect(dueBatch(w.db, w.cfg, "Worker One", "claude", sentAt + 10_000)).toBeNull();
    const nextSlot = lastDigestSlot(sentAt + 2 * 86_400_000, w.cfg)!;
    const batch = dueBatch(w.db, w.cfg, "Worker One", "claude", nextSlot + 1);
    expect(batch?.digestOnly).toBe(true);
    expect(wakeLine(batch!, w.cfg)).toContain("2 FYI notes waiting (TASK-11, TASK-10)");
    expect(wakeLine(batch!, w.cfg)).toContain("Nothing needs action now");
  });

  test("an urgent wake carries waiting FYI along instead of a second wake", () => {
    const w = standardWorld();
    const t0 = Date.now();
    sendMail(w.db, w.cfg, w.directory, w.codex("t-developer"), { ...base, to: "Worker One", kind: "fyi", summary: "Merged PR 9", ticket: "TASK-11" }, t0);
    sendMail(w.db, w.cfg, w.directory, w.codex("t-developer"), { ...base, to: "Worker One", kind: "action", summary: "Rebase PR 10" }, t0 + 1);
    const batch = dueBatch(w.db, w.cfg, "Worker One", "claude", t0 + LATER)!;
    expect(batch.rows).toHaveLength(2);
    expect(wakeLine(batch, w.cfg)).toContain("1 new. [ACTION] Developer · TASK-4: Rebase PR 10.");
    expect(wakeLine(batch, w.cfg)).toContain("1 FYI note waiting (TASK-11)");
  });
});

describe("waking Claude", () => {
  test("posts one user line to the chat's own inbox socket", async () => {
    const w = standardWorld();
    const socketPath = join(w.dir, "inbox.sock");
    const received: string[] = [];
    const server = createServer((conn) => conn.on("data", (d) => received.push(...d.toString().trim().split("\n"))));
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const t0 = Date.now();
    sendMail(w.db, w.cfg, w.directory, w.codex("t-developer"), { ...base, to: "Worker One", kind: "decision", reply: "required", summary: "Merge order?" }, t0);
    expect(await wakeSelfClaude(w.db, w.cfg, "Worker One", socketPath, t0 + LATER, (p, t) => postToClaudeSocket(p, t, ""))).toBe(true);
    server.close();
    const messages = received.map((line) => JSON.parse(line));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "user", message: { role: "user" } });
    expect(messages[0].message.content).toContain("[DECISION] Developer · TASK-4: Merge order?");
    const wake = w.db.query<{ ok: number; method: string }, []>("select ok, method from wakes").get();
    expect(wake).toEqual({ ok: 1, method: "claude-own-socket" });
  });

  test("a missing socket is a failed wake that keeps the mail", async () => {
    const w = standardWorld();
    const t0 = Date.now();
    sendMail(w.db, w.cfg, w.directory, w.codex("t-developer"), { ...base, to: "Worker One" }, t0);
    expect(await wakeSelfClaude(w.db, w.cfg, "Worker One", join(w.dir, "nope.sock"), t0 + LATER)).toBe(false);
    expect(w.db.query<MessageRow, []>("select * from messages").get()).toMatchObject({ state: "unread", wake_state: "failed" });
  });
});

describe("Codex chats that aren't open in the app", () => {
  // codex queue only wakes a chat once the app opens it; otherwise the item waits.
  function queueItem(w: ReturnType<typeof standardWorld>, thread: string, at: number, id = `q${at}`) {
    const db = new Database(w.cfg.codexQueueDb);
    db.query("insert into queued_items (id, thread_id, payload_json, created_at_ms) values (?, ?, '{}', ?)").run(id, thread, at);
    db.close();
    return id;
  }
  function take(w: ReturnType<typeof standardWorld>, id: string) {
    const db = new Database(w.cfg.codexQueueDb);
    db.query("delete from queued_items where id = ?").run(id);
    db.close();
  }
  function recordingOpener() {
    const opened: string[] = [];
    const opener: CodexOpener = async (thread) => {
      opened.push(thread);
      return { ok: true, detail: "opened" };
    };
    return { opened, opener };
  }
  const stuckEvents = (w: ReturnType<typeof standardWorld>) => w.db.query<{ n: number }, []>("select count(*) n from events where type = 'wake-stuck'").get()!.n;

  test("nothing is opened when the chat took its items", async () => {
    const w = standardWorld();
    const t0 = Date.now();
    take(w, queueItem(w, "t-lead", t0));
    const { opened, opener } = recordingOpener();
    await followUpCodex(w.db, w.cfg, w.directory, t0 + LIMITS.codexQueueCheckMs + 1, opener);
    expect(opened).toEqual([]);
  });

  test("an idle chat with an item waiting over 20 s is opened once; still waiting after 3 minutes is logged stuck", async () => {
    const w = standardWorld();
    const t0 = Date.now();
    queueItem(w, "t-lead", t0);
    const { opened, opener } = recordingOpener();
    await followUpCodex(w.db, w.cfg, w.directory, t0 + 5_000, opener);
    expect(opened).toEqual([]);
    const check = t0 + LIMITS.codexQueueCheckMs + 1;
    await followUpCodex(w.db, w.cfg, w.directory, check, opener);
    await followUpCodex(w.db, w.cfg, w.directory, check + 30_000, opener);
    expect(opened).toEqual(["t-lead"]);
    await followUpCodex(w.db, w.cfg, w.directory, check + LIMITS.codexOpenGiveUpMs + 1, opener);
    await followUpCodex(w.db, w.cfg, w.directory, check + LIMITS.codexOpenGiveUpMs + 2, opener);
    expect(stuckEvents(w)).toBe(1);
    // While the stuck item still waits, a newer item does not reopen the chat again.
    queueItem(w, "t-lead", check + LIMITS.codexOpenGiveUpMs + 10);
    await followUpCodex(w.db, w.cfg, w.directory, check + LIMITS.codexOpenGiveUpMs + 10 + LIMITS.codexQueueCheckMs + 1, opener);
    expect(opened).toEqual(["t-lead"]);
  });

  test("a chat that is mid-turn is left alone; it takes queued items when the turn ends", async () => {
    const w = standardWorld();
    const t0 = Date.now();
    queueItem(w, "t-developer", t0); // Developer is busy
    const { opened, opener } = recordingOpener();
    await followUpCodex(w.db, w.cfg, w.directory, t0 + LIMITS.codexQueueCheckMs + 1, opener);
    expect(opened).toEqual([]);
  });

  test("threads outside the Sideband map are never opened", async () => {
    const w = standardWorld();
    const t0 = Date.now();
    queueItem(w, "someone-elses-thread", t0);
    const { opened, opener } = recordingOpener();
    await followUpCodex(w.db, w.cfg, w.directory, t0 + LIMITS.codexQueueCheckMs + 1, opener);
    expect(opened).toEqual([]);
  });
});

describe("held messages", () => {
  test("a blocker held by the rate limit wakes no earlier than its release time", () => {
    const w = standardWorld();
    const me = w.claude(w.pids.coordinator);
    const t0 = Date.now();
    for (let i = 0; i < LIMITS.perPairPerMinute; i += 1) {
      sendMail(w.db, w.cfg, w.directory, me, { ...base, to: "Worker One", kind: "fyi", ticket: `TASK-${i}`, summary: `Note ${i}` }, t0 + i);
    }
    sendMail(w.db, w.cfg, w.directory, me, { ...base, to: "Worker One", kind: "blocker", summary: "Stop the release" }, t0 + 50);
    expect(dueBatch(w.db, w.cfg, "Worker One", "claude", t0 + 30_000)).toBeNull();
    const batch = dueBatch(w.db, w.cfg, "Worker One", "claude", t0 + 60_001);
    expect(batch?.rows.some((r) => r.summary === "Stop the release")).toBe(true);
  });
});
