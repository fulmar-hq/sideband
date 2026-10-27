import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a configured receiver initializes its first store with the configured coordinator", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sideband-receiver-"));
  const path = join(dir, "state", "mail.sqlite");
  const file = join(dir, "sideband.json");
  writeFileSync(file, JSON.stringify({
    version: 1, name: "Receiver fixture", authority: "repository issues", tickets: ["#"],
    agents: [{ address: "Planner", app: "codex", role: "coordinator", threadId: "synthetic-planner" }],
    coordinators: { claude: null, codex: "Planner" },
    paths: { db: path, codexStateDb: join(dir, "absent-state"), codexQueueDb: join(dir, "absent-queue"), codexBin: "/bin/false", claudeLiveDir: join(dir, "absent-sessions"), claudeDesktopDir: join(dir, "absent-desktop") },
  }));
  const child = Bun.spawn(["bun", join(import.meta.dir, "../src/operator-receiver.ts")], {
    env: { ...process.env, SIDEBAND_CONFIG: file }, stdout: "ignore", stderr: "pipe",
  });
  let db: Database | undefined;
  try {
    const deadline = Date.now() + 5000;
    let ready = false;
    while (Date.now() < deadline) {
      if (existsSync(path)) {
        try {
          db ??= new Database(path, { readonly: true });
          ready = Boolean(db.query("select 1 from events where type='operator-receiver-start'").get());
          if (ready) break;
        } catch { /* startup has not committed its schema/event yet */ }
      }
      await Bun.sleep(10);
    }
    expect(ready).toBe(true);
    expect(db!.query<{ address: string }, []>("select address from mail_coordinator_addresses").all()).toEqual([{ address: "Planner" }]);
  } finally {
    // Only this synthetic child/store. Stop before its36-second delivery handover.
    child.kill("SIGTERM");
    await child.exited;
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
