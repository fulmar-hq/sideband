import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { readProjectConfig, validateProjectConfig, type ProjectConfig } from "./project-config";

export { defaultConfigFile } from "./project-config";
export const defaultInstallRoot = () => join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "sideband");
export const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export interface SetupOptions { name?: string; authority?: string; address?: string; codexThread?: string; claudeTitle?: string; starterPair?: boolean }
export function initialize(file: string, options: SetupOptions = {}): { created: boolean; project: ProjectConfig } {
  if (existsSync(file)) return { created: false, project: readProjectConfig(file) };
  if (options.codexThread && options.claudeTitle) throw new Error("Choose one host binding for initialization");
  if (Boolean(options.address) !== Boolean(options.codexThread || options.claudeTitle)) throw new Error("An initial address requires its explicit host binding");
  if (options.starterPair && (options.address || options.codexThread || options.claudeTitle)) throw new Error("Choose starter pair or one native binding");
  const project = validateProjectConfig({
    version: 1, name: options.name ?? "Workspace", authority: options.authority ?? "the project's own instructions and issue tracker",
    tickets: ["#"], coordinators: { claude: options.starterPair ? "Planner" : null, codex: null },
    agents: options.starterPair ? [{ address:"Planner",app:"claude",role:"coordinator",binding:"launch" },{ address:"Engineer",app:"codex",role:"builder",binding:"launch" }] : options.address ? [{ address: options.address, role: "builder", ...(options.codexThread ? { app: "codex", threadId: options.codexThread } : { app: "claude", title: options.claudeTitle }) }] : [],
  });
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { created: true, project };
}

function runtimeFiles(source: string): string[] {
  for (const file of ["package.json", "bun.lock"]) if (lstatSync(join(source, file)).isSymbolicLink()) throw new Error("Package inputs must not be symlinks");
  const walk = (directory: string): string[] => readdirSync(join(source, directory)).flatMap((name) => {
    const path = join(directory, name), stat = lstatSync(join(source, path));
    if (stat.isSymbolicLink()) throw new Error("Runtime sources must not contain symlinks");
    return stat.isDirectory() ? walk(path) : name.endsWith(".ts") ? [path] : [];
  });
  return ["package.json", "bun.lock", ...walk("src")].sort();
}
function fingerprint(root: string, files: string[]): string {
  const digest = createHash("sha256");
  for (const file of files) digest.update(JSON.stringify(file)).update("\n").update(hash(readFileSync(join(root, file)))).update("\n");
  return digest.digest("hex");
}
function plainDirectory(path: string) {
  if (present(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())) throw new Error(`Expected an ordinary installation directory: ${path}`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
function writeAtomic(path: string, body: string, mode = 0o600) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, body, { flag: "wx", mode }); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}

export function install(source: string, rootInput: string, configInput: string, options: SetupOptions = {}) {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("This installer supports macOS and Linux");
  const root = resolve(rootInput), file = resolve(configInput);
  const sourceRoot = resolve(source);
  if (root === sourceRoot || root.startsWith(sourceRoot + sep)) throw new Error("Install outside the source directory");
  if (!file.endsWith(".json") || file.startsWith(join(root, "versions") + sep) || file.startsWith(join(root, "bin") + sep)) throw new Error("Choose a JSON configuration outside managed version/bin directories");
  if (existsSync(file)) readProjectConfig(file); // Refuse invalid existing settings before any install writes.
  const metadata = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  if (metadata.name !== "sideband" || typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(metadata.version)) throw new Error("Invalid Sideband package identity/version");
  const version: string = metadata.version;
  const files = runtimeFiles(source), wanted = fingerprint(source, files);
  const marker = join(root, "sideband-install.json");
  if (present(marker) && lstatSync(marker).isSymbolicLink()) throw new Error("Installation marker must be an ordinary file");
  if (existsSync(root) && !existsSync(marker) && readdirSync(root).length) throw new Error("Installation root is not an owned Sideband directory");
  plainDirectory(root);
  const state: { product: string; version: number; configFile: string; launcherHash?: string } = existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")) : { product: "sideband", version: 1, configFile: file };
  if (state.product !== "sideband" || state.version !== 1 || state.configFile !== file) throw new Error("Installation root belongs to a different configuration or format");
  if (!existsSync(marker)) writeFileSync(marker, JSON.stringify(state), { flag: "wx", mode: 0o600 });
  const lock = join(root, ".install-lock");
  mkdirSync(lock, { mode: 0o700 }); // A concurrent/stale lock refuses; never guessed safe by age.
  let stage: string | undefined;
  try {
    const versions = join(root, "versions"), bin = join(root, "bin"), target = join(versions, version);
    plainDirectory(versions); plainDirectory(bin);
    const binary = join(bin, "sideband"), current = join(root, "current");
    if (present(binary) && (lstatSync(binary).isSymbolicLink() || !state.launcherHash || hash(readFileSync(binary)) !== state.launcherHash)) throw new Error("Refusing to replace an unrecognized launcher");
    if (present(current) && (!lstatSync(current).isSymbolicLink() || !resolve(root, readlinkSync(current)).startsWith(versions + sep))) throw new Error("Refusing to replace an unrecognized current pointer");
    if (present(target)) {
      if (lstatSync(target).isSymbolicLink() || fingerprint(target, files) !== wanted || !existsSync(join(target, "node_modules/@modelcontextprotocol/sdk/package.json"))) throw new Error("Installed version differs or is incomplete; do not overwrite a version");
    } else {
      stage = join(versions, `.staging-${randomUUID()}`); mkdirSync(stage, { mode: 0o700 });
      for (const path of files) {
        mkdirSync(dirname(join(stage, path)), { recursive: true, mode: 0o700 });
        writeFileSync(join(stage, path), readFileSync(join(source, path)), { flag: "wx", mode: 0o600 });
      }
      const dependencies = Bun.spawnSync([process.execPath, "install", "--frozen-lockfile", "--production", "--ignore-scripts"], { cwd: stage, stdout: "pipe", stderr: "pipe" });
      if (dependencies.exitCode !== 0) throw new Error(`Dependency installation failed (exit${dependencies.exitCode}); current version was not switched`);
      if (fingerprint(stage, files) !== wanted) throw new Error("Runtime files changed during installation");
      renameSync(stage, target); stage = undefined;
    }
    const initialized = initialize(file, options);
    const launcher = `#!/bin/sh\nif [ -z "\${SIDEBAND_CONFIG+x}" ]; then\n  SIDEBAND_CONFIG=${shellQuote(file)}\n  export SIDEBAND_CONFIG\nfi\nexec ${shellQuote(process.execPath)} ${shellQuote(join(current, "src/sideband.ts"))} "$@"\n`;
    writeAtomic(binary, launcher, 0o700);
    state.launcherHash = hash(launcher); writeAtomic(marker, `${JSON.stringify(state, null, 2)}\n`);
    const next = join(root, `.current-${randomUUID()}`);
    try { symlinkSync(relative(root, target), next); renameSync(next, current); }
    finally { rmSync(next, { force: true }); }
    chmodSync(binary, 0o700);
    return { version, binary, configFile: file, ...initialized };
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}
