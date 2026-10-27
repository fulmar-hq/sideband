import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { Directory } from "../src/directory";
import { codexCaller, claudeCaller } from "../src/identity";
import { makeWorld } from "./fixture";

const original = process.env.SIDEBAND_CONFIG;
const dirs: string[] = [];
afterEach(() => {
  if (original === undefined) delete process.env.SIDEBAND_CONFIG;
  else process.env.SIDEBAND_CONFIG = original;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function config(value: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "sideband-config-"));
  dirs.push(dir);
  const file = join(dir, "sideband.json");
  writeFileSync(file, JSON.stringify(value));
  process.env.SIDEBAND_CONFIG = file;
  return { file, dir };
}
const project = () => ({
  version: 1, name: "Workshop", authority: "the owning repository issues",
  agents: [
    { address: "Planner", app: "claude", role: "coordinator", title: "Workshop planner" },
    { address: "Engineer", app: "codex", role: "builder", threadId: "workshop-thread" },
  ],
  coordinators: { claude: "Planner", codex: null },
  tickets: ["TASK-", "#"],
});
describe("independent project configuration", () => {
  it("binds arbitrary names to host evidence without a preexisting registry", () => {
    const w = makeWorld();
    w.claudeSession({ pid: process.pid, host: "local_planner", title: "Workshop planner · free" });
    w.codexThread({ id: "workshop-thread", name: "Implementation · TASK-6" });
    const { dir } = config({ ...project(), paths: {
      claudeLiveDir: w.cfg.claudeLiveDir, claudeDesktopDir: w.cfg.claudeDesktopDir,
      codexStateDb: w.cfg.codexStateDb,
    } });
    const cfg = loadConfig();
    const directory = new Directory(cfg);
    expect(cfg.db).toBe(join(dir, "state", "mail.sqlite"));
    expect(codexCaller(cfg, "workshop-thread").address).toBe("Engineer");
    expect(codexCaller(cfg, "unregistered").address).toBeNull();
    expect(claudeCaller(cfg, process.pid).address).toBe("Planner");
    expect(directory.coordinator("codex")?.address).toBe("Planner");
    expect(directory.resolve("engineer")?.ticket).toBe("TASK-6");
    expect(directory.resolve("Unregistered peer")).toBeNull();
    w.db.close();
  });
  it("does not inherit another project's mapping or unrelated environment values", () => {
    const saved = process.env.OTHER_APP_DB;
    process.env.OTHER_APP_DB = "/must-not-open/other.sqlite";
    try {
      const { dir } = config({ ...project(), agents: [], coordinators: { claude: null, codex: null } });
      const cfg = loadConfig();
      expect(cfg.db).toBe(join(dir, "state", "mail.sqlite"));
      expect(new Directory(cfg).all()).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.OTHER_APP_DB;
      else process.env.OTHER_APP_DB = saved;
    }
  });
  it("refuses missing, malformed, unknown and ambiguous configuration instead of falling back", () => {
    config({ ...project(), unexpected: true });
    expect(() => loadConfig()).toThrow();
    config({ ...project(), agents: [...project().agents, { ...project().agents[1], address: "engineer" }] });
    expect(() => loadConfig()).toThrow();
    config({ ...project(), coordinators: { claude: "Engineer", codex: null } });
    expect(() => loadConfig()).toThrow();
    config({ ...project(), agents: project().agents.map((a) => a.address === "Engineer" ? { ...a, role: ["builder"] } : a) });
    expect(() => loadConfig()).toThrow();
    config({ ...project(), agents: project().agents.map(a => ({ ...a, binding: "unknown" })) });
    expect(() => loadConfig()).toThrow();
    config({ ...project(), coordinatorDigestMinutes: [30] });
    expect(() => loadConfig()).toThrow();
    const { file } = config(project());
    writeFileSync(file, "{");
    expect(() => loadConfig()).toThrow();
    rmSync(file);
    expect(() => loadConfig()).toThrow();
  });
  it("refuses a missing explicit file instead of reading another project", () => {
    const {file}=config(project());
    rmSync(file);
    expect(() => loadConfig()).toThrow();
  });
});
