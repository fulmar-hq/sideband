// Trusted local installation settings, never tool arguments or message content.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type AgentRole = "builder" | "coordinator" | "expert" | "relay";
export type AgentBinding = { address: string; role: AgentRole } & (
  | { app: "claude"; binding: "launch"; title?: never }
  | { app: "codex"; binding: "launch"; threadId?: never }
  | { app: "claude"; binding?: "native"; title: string }
  | { app: "codex"; binding?: "native"; threadId: string }
);
export const PROJECT_PATHS = ["db", "claudeLiveDir", "claudeDesktopDir", "codexStateDb", "codexBin", "codexQueueDb"] as const;
export interface ProjectConfig {
  version: 1;
  name: string;
  authority: string;
  agents: AgentBinding[];
  coordinators: { claude: string | null; codex: string | null };
  tickets: string[];
  aliases?: Record<string, string>;
  operator?: string;
  human?: string;
  telegram?: { envFile: string };
  paths?: Partial<Record<(typeof PROJECT_PATHS)[number], string>>;
  timeZone?: string;
  digestTimes?: string[];
  coordinatorDigestMinutes?: number;
}

function fail(message: string): never { throw new Error(`Invalid Sideband configuration: ${message}`); }
function object(value: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${where} must be an object`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) fail(`${where} has an unknown key`);
  return record;
}
function text(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) fail(`${where} must be nonempty single-line text`);
  return value;
}
function address(value: unknown, where: string): string {
  const result = text(value, where);
  if (result.length > 80 || result.includes(",") || result !== result.replace(/\s+/g, " ")) fail(`${where} is not a valid address`);
  return result;
}
export function projectPath(value: string, file: string): string {
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : isAbsolute(value) ? value : resolve(dirname(file), value);
}

export function readProjectConfig(file: string): ProjectConfig {
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error(`Cannot read valid Sideband configuration: ${file}`); }
  return validateProjectConfig(value);
}

export function validateProjectConfig(value: unknown): ProjectConfig {
  const c = object(value, ["version", "name", "authority", "agents", "coordinators", "tickets", "aliases", "operator", "human", "telegram", "paths", "timeZone", "digestTimes", "coordinatorDigestMinutes"], "root");
  if (c.version !== 1) fail("version must be 1");
  text(c.name, "name"); text(c.authority, "authority");
  if (!Array.isArray(c.agents)) fail("agents must be an array");
  const addresses = new Set<string>(), hosts = new Set<string>();
  for (const value of c.agents) {
    const a = object(value, ["address", "app", "role", "binding", "title", "threadId"], "agent");
    const name = address(a.address, "agent address").toLowerCase();
    if (addresses.has(name)) fail("duplicate agent address");
    addresses.add(name);
    if (typeof a.role !== "string" || !["builder", "coordinator", "expert", "relay"].includes(a.role)) fail("unknown agent role");
    if (a.app !== "claude" && a.app !== "codex") fail("unknown agent app");
    if (a.binding !== undefined && a.binding !== "launch" && a.binding !== "native") fail("unknown binding mode");
    if (a.binding === "launch") {
      if (a.title !== undefined || a.threadId !== undefined) fail("launch binding must not include a native identity");
      continue;
    }
    const binding = text(a.app === "claude" ? a.title : a.threadId, "host binding");
    if (a.app === "claude" && (a.threadId !== undefined || binding.includes("·"))) fail("Claude requires a base title without a work separator");
    if (a.app === "codex" && a.title !== undefined) fail("Codex requires a threadId, not a title");
    const key = `${a.app}:${binding}`;
    if (hosts.has(key)) fail("duplicate host binding");
    hosts.add(key);
  }
  const routes = object(c.coordinators, ["claude", "codex"], "coordinators");
  for (const app of ["claude", "codex"] as const) {
    if (routes[app] === null) continue;
    const target = address(routes[app], `${app} coordinator`);
    if (!(c.agents as AgentBinding[]).some((a) => a.address === target && a.app === app && a.role === "coordinator")) fail("coordinator must reference a configured coordinator on its app");
  }
  if (!Array.isArray(c.tickets) || !c.tickets.length || !c.tickets.every((p) => typeof p === "string" && (p === "#" || /^[A-Z][A-Z0-9]{0,15}-$/.test(p)))) fail("tickets must contain literal prefixes such as TASK- or #");
  if (c.aliases !== undefined) {
    if (!c.aliases || typeof c.aliases !== "object" || Array.isArray(c.aliases)) fail("aliases must be an address map");
    const seen = new Set<string>();
    for (const [alias, target] of Object.entries(c.aliases)) {
      const key = address(alias, "alias").toLowerCase();
      if (seen.has(key)) fail("duplicate alias");
      seen.add(key);
      if (!(c.agents as AgentBinding[]).some((a) => a.address === address(target, "alias target"))) fail("alias target must be a registered address");
    }
  }
  if (c.human !== undefined) {
    const name = address(c.human, "human");
    if (addresses.has(name.toLowerCase())) fail("human and agent addresses must differ");
  }
  if (c.operator !== undefined && !(c.agents as AgentBinding[]).some((a) => a.address === c.operator && a.app === "codex")) fail("operator must reference a configured Codex agent");
  if (c.telegram !== undefined) {
    const t = object(c.telegram, ["envFile"], "telegram");
    text(t.envFile, "telegram.envFile");
    if (!c.human) fail("Telegram requires a human address");
  }
  if (c.paths !== undefined) {
    const paths = object(c.paths, PROJECT_PATHS, "paths");
    for (const value of Object.values(paths)) text(value, "path");
  }
  if (c.timeZone !== undefined) {
    const zone = text(c.timeZone, "timeZone");
    try { new Intl.DateTimeFormat("en", { timeZone: zone }); } catch { fail("unknown timeZone"); }
  }
  if (c.digestTimes !== undefined && (!Array.isArray(c.digestTimes) || !c.digestTimes.every((t) => typeof t === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t)))) fail("digestTimes must contain HH:mm times");
  if (c.coordinatorDigestMinutes !== undefined && (typeof c.coordinatorDigestMinutes !== "number" || !Number.isInteger(c.coordinatorDigestMinutes) || c.coordinatorDigestMinutes < 0 || c.coordinatorDigestMinutes > 1440)) fail("coordinatorDigestMinutes must be an integer from0to1440");
  return c as unknown as ProjectConfig;
}

export function ticketPattern(prefixes: string[]): RegExp {
  const escaped = prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?:${escaped.join("|")})[0-9]+`);
}

export const defaultConfigFile = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "sideband", "sideband.json");
