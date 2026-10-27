import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install } from "../src/setup";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "sideband-setup-")); roots.push(dir);
  return { dir, root: join(dir, "install ' $(false)"), config: join(dir, "project", "sideband.json") };
}
async function cli(...args: string[]) {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "../src/sideband.ts"), ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() };
}
test("one setup command installs a usable versioned CLI without changing an existing config", async () => {
  const f = fixture();
  const first = await cli("install", "--root", f.root, "--config", f.config, "--name", "Workshop");
  expect(first.code).toBe(0);
  const original = readFileSync(f.config, "utf8");
  expect(JSON.parse(original).agents).toEqual([]);
  const binary = join(f.root, "bin", "sideband");
  const doctor = Bun.spawn([binary, "doctor"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, SIDEBAND_CONFIG: undefined } });
  expect(await doctor.exited).toBe(0);
  expect(await new Response(doctor.stdout).text()).toContain("Workshop");
  expect(existsSync(join(f.dir, "project", "state", "mail.sqlite"))).toBe(false);
  const repeated = await cli("install", "--root", f.root, "--config", f.config, "--name", "Must not replace Workshop");
  expect(repeated.code).toBe(0);
  expect(readFileSync(f.config, "utf8")).toBe(original);
  const current = readlinkSync(join(f.root, "current"));
  writeFileSync(join(f.root, "current", "src", "version.ts"), "// changed installed source\n");
  expect((await cli("install", "--root", f.root, "--config", f.config)).code).not.toBe(0);
  expect(readlinkSync(join(f.root, "current"))).toBe(current);
  expect(readFileSync(f.config, "utf8")).toBe(original);
});
test("initialization is explicit and preserves existing or invalid files", async () => {
  const f = fixture();
  expect((await cli("init", "--config", f.config, "--name", "Workshop", "--address", "Engineer", "--codex-thread", "synthetic-thread")).code).toBe(0);
  expect(JSON.parse(readFileSync(f.config, "utf8")).agents[0].threadId).toBe("synthetic-thread");
  writeFileSync(f.config, "not valid JSON");
  expect((await cli("init", "--config", f.config)).code).not.toBe(0);
  expect(readFileSync(f.config, "utf8")).toBe("not valid JSON");
});
test("an empty new CLI never falls back to the unrelated store", async () => {
  const f = fixture();
  expect((await cli("agents", "--config", f.config)).code).not.toBe(0);
  expect(existsSync(f.config)).toBe(false);
  expect((await cli("--version")).code).toBe(0);
});
test("an unowned installation directory is left untouched", async () => {
  const f = fixture(); mkdirSync(f.root);
  writeFileSync(join(f.root, "keep.txt"), "Existing unrelated file");
  expect((await cli("install", "--root", f.root, "--config", f.config)).code).not.toBe(0);
  expect(readFileSync(join(f.root, "keep.txt"), "utf8")).toBe("Existing unrelated file");
  expect(existsSync(join(f.root, "sideband-install.json"))).toBe(false);
});
test("a dependency failure leaves the old version and configuration active", async () => {
  const f = fixture();
  expect((await cli("install", "--root", f.root, "--config", f.config)).code).toBe(0);
  const before = readlinkSync(join(f.root, "current")), config = readFileSync(f.config, "utf8");
  const source = join(f.dir, "new-source"); mkdirSync(join(source, "src"), { recursive: true });
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "sideband", version: "9.9.9" }));
  writeFileSync(join(source, "bun.lock"), "synthetic"); writeFileSync(join(source, "src", "sideband.ts"), "// synthetic next version");
  const dependencies = spyOn(Bun, "spawnSync").mockImplementation(() => { throw new Error("synthetic dependency failure"); });
  try { expect(() => install(source, f.root, f.config)).toThrow("synthetic dependency failure"); }
  finally { dependencies.mockRestore(); }
  expect(readlinkSync(join(f.root, "current"))).toBe(before);
  expect(readFileSync(f.config, "utf8")).toBe(config);
  expect(existsSync(join(f.root, "versions", "9.9.9"))).toBe(false);
});
