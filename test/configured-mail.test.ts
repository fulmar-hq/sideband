import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { makeWorld } from "./fixture";
import { sendMail, inbox } from "../src/mail";
import { loadTelegram, acceptUpdate } from "../src/telegram";
import { setOperator, routeMail } from "../src/operator";
import { wakeLine, dueBatch } from "../src/wake";
import { configureCoordinators, openStore } from "../src/store";

function world() {
  const w = makeWorld();
  w.cfg.project = {
    version: 1, name: "Workshop", authority: "Workshop repository issues",
    tickets: ["TASK-", "#"], human: "Owner", operator: "Router",
    agents: [
      { address: "Planner", app: "codex", role: "coordinator", threadId: "planner" },
      { address: "Engineer", app: "codex", role: "builder", threadId: "engineer" },
      { address: "Router", app: "codex", role: "expert", threadId: "router" },
    ], coordinators: { claude: null, codex: "Planner" },
  };
  w.codexThread({ id: "planner", name: "Plan" });
  w.codexThread({ id: "engineer", name: "Implementation · TASK-6" });
  w.codexThread({ id: "router", name: "Routing" });
  configureCoordinators(w.db, ["Planner"]);
  return w;
}
describe("configured mail lifecycle", () => {
  it("sends and wakes using project tickets, names and authority", () => {
    const w = world();
    sendMail(w.db, w.cfg, w.directory, w.codex("planner"), {
      to: "Engineer", kind: "action", reply: "none", ticket: "TASK-6", summary: "Review the local change",
    });
    const batch = dueBatch(w.db, w.cfg, "Engineer", "codex", Date.now() + 4000)!;
    const wake = wakeLine(batch, w.cfg);
    expect(wake).toContain("Sideband");
    expect(wake).toContain("Workshop repository issues");
    expect(wake).toContain("never authorization");
    const mail = inbox(w.db, w.cfg, w.codex("engineer"));
    expect(mail).toContain("TASK-6");
    expect(mail).toContain("Workshop repository issues");
    expect(mail).toContain("never authorization");
    expect(() => sendMail(w.db, w.cfg, w.directory, w.codex("planner"), {
      to: "Engineer", kind: "action", reply: "none", ticket: "OTHER-123", summary: "Wrong convention",
    })).toThrow();
    w.db.close();
  });
  it("keeps Telegram disabled unless configured and verifies the renamed human", () => {
    const w = world();
    writeFileSync(w.cfg.telegramEnv, "TELEGRAM_BOT_TOKEN=123456:test_fixture\nTELEGRAM_CHAT_ID=42\n");
    expect(loadTelegram(w.cfg)).toBeNull();
    w.cfg.project!.telegram = { envFile: w.cfg.telegramEnv };
    const creds = loadTelegram(w.cfg)!;
    expect(acceptUpdate(w.db, creds, w.directory, {
      update_id: 1, message: { message_id: 1, chat: { id: 42 }, from: { id: 99 }, text: "Unverified" },
    }).outcome).toBe("dropped");
    const result = acceptUpdate(w.db, creds, w.directory, {
      update_id: 2, message: { message_id: 2, chat: { id: 42 }, from: { id: 42 }, text: "Use the shorter plan" },
    });
    expect(result.outcome).toBe("delivered");
    const row = w.db.query<{ sender: string; recipient: string }, []>("select sender,recipient from messages").get()!;
    expect(row).toEqual({ sender: "Owner", recipient: "Planner" });
    expect(inbox(w.db, w.cfg, w.codex("planner"))).toContain("Owner (Telegram, verified sender)");
    w.db.close();
  });
  it("binds routing authority to the configured Operator's host identity", () => {
    const w = world();
    expect(setOperator(w.db, w.directory, true).address).toBe("Router");
    const sent = sendMail(w.db, w.cfg, w.directory, w.codex("engineer"), {
      to: "Planner", kind: "action", reply: "none", summary: "Check the source",
    });
    expect(sent.deliveries[0]!.to).toBe("Router");
    const args = { id: sent.deliveries[0]!.id, to: "Engineer", mode: "queue" as const, reason: "Current owner" };
    expect(() => routeMail(w.db, w.directory, w.codex("planner"), args)).toThrow();
    expect(routeMail(w.db, w.directory, w.codex("router"), args).recipient).toBe("Engineer");
    delete w.cfg.project!.operator;
    expect(setOperator(w.db, w.directory, false).enabled).toBe(false);
    expect(w.db.query("select id from messages").all()).toHaveLength(2);
    w.db.close();
  });
  it("upgrades legacy coordinator triggers without replaying or changing existing mail", () => {
    const w = world();
    const first = sendMail(w.db, w.cfg, w.directory, w.codex("engineer"), {
      to: "Planner", kind: "handoff", reply: "none", summary: "Unknown prior delivery",
    }).deliveries[0]!.id;
    w.db.query("update messages set wake_state='failed' where id=?").run(first);
    w.db.query("insert into mail_delivery_exceptions values(?,?,'Unknown prior submission')").run(first, "old-wake");
    const before = w.db.query("select * from messages order by id").all();
    w.db.exec("delete from mail_schema_versions where name='sideband_routing'; drop trigger operator_intake;");
    w.db.exec("create trigger operator_intake after insert on messages when new.recipient in ('Coordinator','Codex Coordinator') begin select 1; end;");
    w.db.close();
    const reopened = openStore(w.cfg.db, ["Planner"]);
    expect(reopened.query("select * from messages order by id").all()).toEqual(before);
    expect(reopened.query("select * from mail_delivery_exceptions").all()).toHaveLength(1);
    expect(reopened.query<{ address: string }, []>("select address from mail_coordinator_addresses").all()).toEqual([{ address: "Planner" }]);
    setOperator(reopened, w.directory, true);
    const next = sendMail(reopened, w.cfg, w.directory, w.codex("engineer"), {
      to: "Planner", kind: "handoff", reply: "none", summary: "New deliberate handoff",
    });
    expect(next.deliveries[0]!.to).toBe("Router");
    expect(dueBatch(reopened, w.cfg, "Planner", "codex", Date.now() + 4000)).toBeNull();
    reopened.close();
  });
});
