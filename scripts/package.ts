#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

function git(source: string, ...args: string[]): Buffer {
  const result = Bun.spawnSync(["git", "-C", source, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`Release Git ${args[0]} failed`);
  return result.stdout;
}
function immutable(path: string, content: Buffer | string) {
  const bytes = Buffer.from(content);
  if (existsSync(path)) {
    if (!readFileSync(path).equals(bytes)) throw new Error("A different artifact already exists at this version path");
  } else writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
}
function privateRuntimePath(path: string): boolean {
  if (/[\x00-\x1f\x7f]/.test(path)) return true;
  const blocked = new Set([".git", ".sideband", "node_modules", "state", "logs", "backups", "sideband.json"]);
  return path.split("/").some((part) => {
    const name = part.toLowerCase();
    return blocked.has(name) || /^\.env(?:\.|$)/.test(name) || name.endsWith(".env") || /\.(?:sqlite3?|db)(?:[.-]|$)/.test(name) || /\.(?:log|bak)(?:[.-]|$)/.test(name) || name.endsWith("~");
  });
}
/** Archive committed allowlisted source only, never the working tree or installed runtime. */
export function packageRelease(source: string, ref: string, output: string) {
  const commit = git(source, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`).toString().trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Expected an exact source commit");
  const metadata = JSON.parse(git(source, "show", `${commit}:package.json`).toString());
  const version: unknown = metadata.version;
  if (metadata.name !== "sideband" || typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error("Invalid Sideband release version");
  const tag = ref.replace(/^refs\/tags\//, "");
  if (/^v\d/.test(tag) && tag !== `v${version}`) throw new Error("Tag and package version differ");
  const roots = new Set(git(source, "ls-tree", "--name-only", commit).toString().trim().split("\n"));
  for (const required of ["src", "package.json", "bun.lock"]) if (!roots.has(required)) throw new Error("Release is missing required runtime source");
  const allowed = ["src", "test", "scripts", "docs", "README.md", "AGENTS.md", "CHANGELOG.md", "package.json", "bun.lock", "tsconfig.json", "LICENSE"].filter((path) => roots.has(path));
  const paths = git(source, "ls-tree", "-r", "--name-only", "-z", commit).toString().split("\0").filter(Boolean);
  if (paths.some((path) => allowed.includes(path.split("/")[0]!) && privateRuntimePath(path))) throw new Error("Private/runtime path inside release source; remove it before packaging");
  const tar = git(source, "archive", "--format=tar", `--prefix=sideband-${version}/`, commit, "--", ...allowed);
  const bytes = gzipSync(tar, { level: 9 });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const archive = join(output, `sideband-v${version}.tar.gz`), checksum = `${archive}.sha256`, manifest = join(output, `sideband-v${version}.json`);
  immutable(archive, bytes);
  immutable(checksum, `${sha256}  ${basename(archive)}\n`);
  immutable(manifest, `${JSON.stringify({ version, commit, sha256, archive: basename(archive) }, null, 2)}\n`);
  return { version, commit, sha256, archive, checksum, manifest };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    function take(flag: string, fallback: string) {
      const at = args.indexOf(flag);
      if (at < 0) return fallback;
      if (!args[at + 1] || args[at + 1]!.startsWith("--") || args.indexOf(flag, at + 1) >= 0) throw new Error(`Expected one value for ${flag}`);
      const value = args[at + 1]!; args.splice(at, 2); return value;
    }
    const ref = take("--ref", "HEAD"), output = resolve(take("--output", "dist"));
    if (args.length) throw new Error("Unknown release arguments");
    console.log(JSON.stringify(packageRelease(resolve(import.meta.dir, ".."), ref, output), null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : "Release packaging failed"); process.exitCode = 1; }
}
