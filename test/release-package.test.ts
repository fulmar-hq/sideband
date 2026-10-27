import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRelease } from "../scripts/package";
import { install } from "../src/setup";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(version: unknown = "1.2.3") {
  const root = mkdtempSync(join(tmpdir(), "sideband-package-")); roots.push(root);
  const repo = join(root, "repo"); mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "sideband", version, private: true }));
  writeFileSync(join(repo, "bun.lock"), "synthetic lock");
  writeFileSync(join(repo, "src", "index.ts"), "// synthetic runtime\n");
  // Even tracked private/state/dependency paths must stay outside the artifact allowlist.
  writeFileSync(join(repo, ".env"), "SYNTHETIC_PRIVATE_FIXTURE=yes");
  mkdirSync(join(repo, "state")); writeFileSync(join(repo, "state", "mail.sqlite"), "synthetic");
  mkdirSync(join(repo, "node_modules")); writeFileSync(join(repo, "node_modules", "fixture"), "synthetic");
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode) throw new Error("Synthetic Git fixture failed");
  };
  git("init", "-q"); git("add", ".");
  // A throwaway unsigned fixture commit, not a product commit or a signing-policy change.
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Synthetic fixture");
  return { root, repo, git };
}
test("release artifacts bind exact committed source and exclude private/state/dependency paths", () => {
  const f = fixture();
  const first = packageRelease(f.repo, "HEAD", join(f.root, "first"));
  writeFileSync(join(f.repo, "src", "index.ts"), "// uncommitted change must not ship\n");
  const second = packageRelease(f.repo, "HEAD", join(f.root, "second"));
  expect(readFileSync(first.archive)).toEqual(readFileSync(second.archive));
  expect(readFileSync(first.checksum, "utf8")).toContain(first.sha256);
  const listed = Bun.spawnSync(["tar", "-tzf", first.archive], { stdout: "pipe" }).stdout.toString();
  expect(listed).toContain("sideband-1.2.3/src/index.ts");
  expect(listed).not.toMatch(/\.env|mail.sqlite|node_modules/);
});
test("malformed versions and mismatched tags are refused before creating an artifact", () => {
  for (const version of [["1.2.3"], "../../escape"]) {
    const f = fixture(version);
    expect(() => packageRelease(f.repo, "HEAD", join(f.root, "out"))).toThrow();
    const root = join(f.root, "installation");
    expect(() => install(f.repo, root, join(f.root, "sideband.json"))).toThrow("Invalid Sideband package identity/version");
    expect(existsSync(root)).toBe(false);
  }
  const f = fixture();
  f.git("tag", "v9.9.9");
  expect(() => packageRelease(f.repo, "v9.9.9", join(f.root, "out"))).toThrow();
});
test("private runtime files nested inside allowed source roots refuse packaging", () => {
  for (const path of ["src/.env", "docs/nested/state/mail.sqlite", "src/node_modules/private.txt"]) {
    const f = fixture();
    const parts = path.split("/"); parts.pop(); mkdirSync(join(f.repo, ...parts), { recursive: true });
    writeFileSync(join(f.repo, path), "SYNTHETIC_PRIVATE_FIXTURE");
    f.git("add", path);
    f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Nested private fixture");
    expect(() => packageRelease(f.repo, "HEAD", join(f.root, "out"))).toThrow("Private/runtime path");
    expect(existsSync(join(f.root, "out"))).toBe(false);
  }
});
