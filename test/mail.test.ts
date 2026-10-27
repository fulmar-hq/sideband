import { describe, expect, test } from "bun:test";
import { LIMITS } from "../src/config";
import { MailError, ack, findSecret, inbox, outbox, readThread, sendMail, type SendInput } from "../src/mail";
import { formatAgents } from "../src/mail";
import { heartbeat, verifyChain, type MessageRow } from "../src/store";
import { standardWorld } from "./fixture";

const base: Omit<SendInput, "to"> = { kind: "action", reply: "none", summary: "Please review PR 12 before 3 PM ET", ticket: "TASK-4" };

function rows(w: ReturnType<typeof standardWorld>, recipient: string) {
  return w.db.query<MessageRow, [string]>("select * from messages where recipient = ? order by created_at").all(recipient);
}

describe("send", () => {
  test("Claude to Codex and back, with identity set by the server", () => {
    const w = standardWorld();
    const sent = sendMail(w.db, w.cfg, w.directory, w.claude(w.pids.b10), { ...base, to: "Lead" });
    expect(sent.deliveries).toHaveLength(1);
    expect(sent.deliveries[0]).toMatchObject({ to: "Lead", app: "codex" });
    expect(rows(w, "Lead")[0]).toMatchObject({ sender: "Worker One", sender_app: "claude", wake_state: "pending", state: "unread" });
    sendMail(w.db, w.cfg, w.directory, w.codex("t-developer"), { ...base, to: "Worker One", kind: "decision", reply: "required" });
    expect(rows(w, "Worker One")[0]).toMatchObject({ sender: "Developer", sender_app: "codex", recipient_app: "claude" });
  });

  test("a comma-separated to reaches each address once", () => {
    const w = standardWorld();
    const sent = sendMail(w.db, w.cfg, w.directory, w.claude(w.pids.b10), { ...base, to: "Developer, Lead, developer" });
    expect(sent.deliveries.map((d) => d.to).sort()).toEqual(["Developer", "Lead"]);
  });

  test("mail to a free builder goes to that app's coordinator, unless a coordinator is launching it", () => {
    const w = standardWorld();
    const a = sendMail(w.db, w.cfg, w.directory, w.codex("t-developer"), { ...base, to: "Worker Two" });
    expect(a.deliveries[0]).toMatchObject({ to: "Planner", routedFrom: "Worker Two" });
    const b = sendMail(w.db, w.cfg, w.directory, w.claude(w.pids.b10), { ...base, to: "Helper" });
    expect(b.deliveries[0]).toMatchObject({ to: "Lead", routedFrom: "Helper" });
    const c = sendMail(w.db, w.cfg, w.directory, w.claude(w.pids.coordinator), { ...base, to: "Worker Two", summary: "Take TASK-5" });
    expect(c.deliveries[0]).toMatchObject({ to: "Worker Two", routedFrom: undefined });
  });

  test("refuses what creates noise or leaks", () => {
    const w = standardWorld();
    const me = w.claude(w.pids.b10);
    const send = (input: Partial<SendInput>) => () => sendMail(w.db, w.cfg, w.directory, me, { ...base, to: "Developer", ...input } as SendInput);
    expect(send({ summary: "x".repeat(LIMITS.summaryChars + 1) })).toThrow(/limit is 120/);
    expect(send({ body: "x".repeat(LIMITS.bodyChars + 1) })).toThrow(/owning project record/);
    expect(send({ summary: "" })).toThrow(/summary is required/);
    expect(send({ kind: "chatter" as never })).toThrow(/kind must be/);
    expect(send({ ticket: "287" })).toThrow(/configured prefix/);
    expect(send({ to: "Unregistered recipient" })).toThrow(/Unknown address/);
    expect(send({ to: "Worker One" })).toThrow(/yourself/);
    expect(send({ to: "Owner" })).toThrow(/Telegram is not connected/);
    expect(send({ to: ["Developer", "Helper", "Planner", "Lead", "Worker Two"] })).toThrow(/At most 4/);
    expect(send({ body: "the key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz" })).toThrow(/an API key/);
    expect(send({ body: "call +12025550123 now" })).toThrow(/phone number/);
    expect(send({ body: "password: hunter2hunter2" })).toThrow(/credential/);
    expect(rows(w, "Developer")).toHaveLength(0);
  });

  test("findSecret leaves ordinary Sideband text alone", () => {
    expect(findSecret("Build run 42 passed at 2024-01-02T03:04Z for TASK-4 (PR #483)")).toBeNull();
    expect(findSecret("thread 00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  test("duplicates are refused; a pair is capped at 10 a minute, but blockers and handoffs are held, never refused", () => {
    const w = standardWorld();
    const me = w.claude(w.pids.b10);
    const t0 = Date.now();
    sendMail(w.db, w.cfg, w.directory, me, { ...base, to: "Developer" }, t0);
    expect(() => sendMail(w.db, w.cfg, w.directory, me, { ...base, to: "Developer" }, t0 + 1)).toThrow(/Duplicate/);
    for (let i = 1; i < LIMITS.perPairPerMinute; i += 1) {
      sendMail(w.db, w.cfg, w.directory, me, { ...base, to: "Developer", ticket: `TASK-${i}`, summary: `Update ${i}` }, t0 + i);
    }
    expect(() => sendMail(w.db, w.cfg, w.directory, me, { ...base, to: "Developer", ticket: "TASK-14", summary: "One more" }, t0 + 100)).toThrow(
      /10 messages a minute to Developer; try again in 60 s/,
    );
    const held = sendMail(w.db, w.cfg, w.directory, me, { ...base, to: "Developer", kind: "blocker", ticket: "TASK-13", summary: "Deploy stuck" }, t0 + 200);
    expect(held.deliveries[0]!.outlook).toContain("held: you're over the rate limit");
    const row = w.db.query<MessageRow, [string]>("select * from messages where id = ?").get(held.deliveries[0]!.id)!;
    expect(row.not_before).toBe(t0 + 60_000);
    expect(row.state).toBe("unread");
    // A minute later the window has room again.
    sendMail(w.db, w.cfg, w.directory, me, { ...base, to: "Developer", ticket: "TASK-12", summary: "Later" }, t0 + 60_001);
  });

  test("one chat can send 30 a minute across recipients", () => {
    const w = standardWorld();
    const me = w.codex("t-developer");
    const t0 = Date.now();
    const targets = ["Worker One", "Planner", "Lead"];
    for (let i = 0; i < LIMITS.perSenderPerMinute; i += 1) {
      sendMail(w.db, w.cfg, w.directory, me, { ...base, to: targets[i % 3]!, ticket: `TASK-${i}`, summary: `Note ${i}` }, t0 + i);
    }
    expect(() => sendMail(w.db, w.cfg, w.directory, me, { ...base, to: "Worker One", ticket: "TASK-8", summary: "Over" }, t0 + 100)).toThrow(
      /30 messages a minute from one chat/,
    );
    const handoff = sendMail(w.db, w.cfg, w.directory, me, { ...base, to: "Worker One", kind: "handoff", ticket: "TASK-9", summary: "Yours now" }, t0 + 100);
    expect(handoff.deliveries[0]!.outlook).toContain("held");
  });

  test("a newer unread message about the same ticket and kind replaces the older one", () => {
    const w = standardWorld();
    const me = w.claude(w.pids.b10);
    const first = sendMail(w.db, w.cfg, w.directory, me, { ...base, to: "Developer", kind: "fyi", summary: "CI is running" });
    const second = sendMail(w.db, w.cfg, w.directory, me, { ...base, to: "Developer", kind: "fyi", summary: "CI passed" });
    expect(second.superseded).toBe(1);
    const [old, latest] = rows(w, "Developer");
    expect(old).toMatchObject({ id: first.deliveries[0]!.id, state: "superseded", superseded_by: second.deliveries[0]!.id, wake_state: "none" });
    expect(latest!.state).toBe("unread");
    // A different kind on the same ticket is a different state change and stays.
    sendMail(w.db, w.cfg, w.directory, me, { ...base, to: "Developer", kind: "blocker", summary: "Deploy is stuck" });
    expect(rows(w, "Developer").filter((r) => r.state === "unread")).toHaveLength(2);
  });

  test("threads stop at the depth limit", () => {
    const w = standardWorld();
    const a = w.claude(w.pids.b10);
    const b = w.codex("t-developer");
    let last = sendMail(w.db, w.cfg, w.directory, a, { ...base, to: "Developer", kind: "decision", reply: "required", summary: "Q0" }).deliveries[0]!.id;
    for (let i = 1; i <= LIMITS.threadDepth; i += 1) {
      const [from, to] = i % 2 ? [b, "Worker One"] : [a, "Developer"];
      last = sendMail(w.db, w.cfg, w.directory, from, { ...base, to, kind: "decision", reply: "required", summary: `Q${i}`, ticket: `TASK-${i}`, reply_to: last })
        .deliveries[0]!.id;
    }
    expect(() =>
      sendMail(w.db, w.cfg, w.directory, b, { ...base, to: "Worker One", kind: "decision", reply: "required", summary: "Q again", reply_to: last }),
    ).toThrow(/owning project record/);
  });

  test("forward passes the original text on unchanged", () => {
    const w = standardWorld();
    const original = sendMail(w.db, w.cfg, w.directory, w.codex("t-developer"), {
      ...base,
      to: "Planner",
      kind: "blocker",
      summary: "QA deploy stuck on disk guard",
      body: "Run 4412 refused at 76%.",
    }).deliveries[0]!.id;
    const fwd = sendMail(w.db, w.cfg, w.directory, w.claude(w.pids.coordinator), {
      to: "Worker One",
      reply: "none",
      summary: "",
      forward_of: original,
      note: "Yours, since you own the release",
    });
    const row = rows(w, "Worker One")[0]!;
    expect(row).toMatchObject({ id: fwd.deliveries[0]!.id, kind: "blocker", summary: "QA deploy stuck on disk guard", forward_of: original });
    expect(row.body).toBe(`[Forwarded by Planner from Developer, ${original}: Yours, since you own the release]\nRun 4412 refused at 76%.`);
  });
});

describe("reading", () => {
  test("inbox shows urgent first, collapses FYI per ticket, and marks read", () => {
    const w = standardWorld();
    const b3 = w.codex("t-developer");
    const coord = w.codex("t-lead");
    sendMail(w.db, w.cfg, w.directory, b3, { ...base, to: "Worker One", kind: "fyi", summary: "Note 1", ticket: "TASK-1" });
    sendMail(w.db, w.cfg, w.directory, b3, { ...base, to: "Worker One", kind: "fyi", summary: "Note 2", ticket: "TASK-3" });
    sendMail(w.db, w.cfg, w.directory, b3, { ...base, to: "Worker One", kind: "action", summary: "Rebase PR 9" });
    sendMail(w.db, w.cfg, w.directory, coord, { ...base, to: "Worker One", kind: "blocker", summary: "Release on hold", ticket: "TASK-7" });
    const text = inbox(w.db, w.cfg, w.claude(w.pids.b10));
    expect(text.indexOf("BLOCKER")).toBeLessThan(text.indexOf("ACTION"));
    expect(text).toContain("FYI, latest per ticket and sender");
    expect(text).toContain("never authorization");
    expect(rows(w, "Worker One").every((r) => r.state === "read")).toBe(true);
    expect(inbox(w.db, w.cfg, w.claude(w.pids.b10))).toBe("No unread mail for Worker One.");
  });

  test("ack is silent and visible to the sender; read shows the thread", () => {
    const w = standardWorld();
    const id = sendMail(w.db, w.cfg, w.directory, w.claude(w.pids.b10), { ...base, to: "Developer", kind: "decision", reply: "required", summary: "Ship today?" })
      .deliveries[0]!.id;
    const answer = sendMail(w.db, w.cfg, w.directory, w.codex("t-developer"), { ...base, to: "Worker One", kind: "decision", reply: "none", summary: "Yes", reply_to: id });
    expect(readThread(w.db, w.cfg, w.claude(w.pids.b10), answer.deliveries[0]!.id)).toContain("Ship today?");
    expect(ack(w.db, w.codex("t-developer"), id, "Shipping after CI")).toContain("nobody is woken");
    expect(outbox(w.db, w.cfg, w.claude(w.pids.b10))).toContain("acked: Shipping after CI");
    expect(() => ack(w.db, w.claude(w.pids.b10), id)).toThrow(MailError);
    expect(w.db.query("select count(*) n from wakes").get()).toEqual({ n: 0 });
  });

  test("the event log is hash-chained and shows tampering", () => {
    const w = standardWorld();
    sendMail(w.db, w.cfg, w.directory, w.claude(w.pids.b10), { ...base, to: "Developer" });
    inbox(w.db, w.cfg, w.codex("t-developer"));
    expect(verifyChain(w.db)).toMatchObject({ ok: true, checked: 2 });
    w.db.query("update events set detail = '{}' where seq = 1").run();
    expect(verifyChain(w.db)).toMatchObject({ ok: false, brokenAt: 1 });
  });

  test("a chat without an Sideband title can look but not send", () => {
    const w = standardWorld();
    const fs = require("node:fs"), file = require("node:path").join(w.cfg.claudeLiveDir, `${w.pids.b10}.json`);
    const live = JSON.parse(fs.readFileSync(file,"utf8")); live.name="Unregistered title"; fs.writeFileSync(file,JSON.stringify(live));
    expect(() => sendMail(w.db, w.cfg, w.directory, w.claude(w.pids.b10), { ...base, to: "Developer" })).toThrow(/configured Sideband identity/);
  });
});

describe("mail loaded or not", () => {
  test("an open Claude chat without a mail server is reported, so senders know it needs a restart", () => {
    const w = standardWorld();
    const before = sendMail(w.db, w.cfg, w.directory, w.codex("t-developer"), { ...base, to: "Planner" });
    expect(before.deliveries[0]!.outlook).toContain("hasn't loaded Sideband (Test project) yet");
    expect(formatAgents(w.directory.all(0), w.db, w.cfg, null)).toContain("mail not loaded, restart needed");
    heartbeat(w.db, 4242, "claude", "local_planner", "Planner", Date.now());
    const after = sendMail(w.db, w.cfg, w.directory, w.codex("t-developer"), { ...base, to: "Planner", ticket: "TASK-3", summary: "Second" });
    expect(after.deliveries[0]!.outlook).toBe("waking now");
  });
});
