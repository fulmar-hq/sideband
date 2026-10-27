// The live directory: who exists, what they are working on and whether they are around.
// It reads each app's own local records (read-only), so chat titles stay the single source of truth.
import { Database } from "bun:sqlite";
import { existsSync, openSync, readFileSync, readSync, readdirSync, statSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import type { App } from "./store";
import { ticketPattern } from "./project-config";
import { humanAddress, operatorAddress } from "./context";

export type Role = "builder" | "coordinator" | "expert" | "relay";

export interface Agent {
  address: string;
  app: App;
  role: Role;
  title: string;
  /** free and working come from the chat title rule; role is a coordinator, expert or relay chat. */
  work: "free" | "working" | "role";
  task?: string;
  ticket?: string;
  presence: "busy" | "idle" | "closed" | "connected" | "unknown";
  manualInbox?: boolean;
  lastActive: number | null;
  /** Claude desktop session id, or Codex thread id. */
  ref: string;
  pid?: number;
  socket?: string;
  /** Other chats whose title claims the same address. */
  duplicates: string[];
}

interface ParsedTitle {
  address: string;
  role: Role;
  work: Agent["work"];
  task?: string;
  ticket?: string;
}

function parseWork(rest: string, cfg: Config): Pick<ParsedTitle, "work" | "task" | "ticket"> {
  const parts = rest
    .split("·")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts[0]!.toLowerCase() === "free") return { work: "free" };
  const pattern = ticketPattern(cfg.project.tickets);
  const ticketPart = [...parts].reverse().find((p) => pattern.test(p));
  const ticket = ticketPart?.match(pattern)?.[0];
  const task = parts.filter((p) => p !== ticketPart).join(" · ") || undefined;
  return { work: "working", task, ticket };
}


export function parseClaudeTitle(title: string, cfg: Config): ParsedTitle | null {
  const t = title.trim();
  const a = cfg.project.agents.find((a) => a.app === "claude" && a.binding !== "launch" && (t === a.title || t.startsWith(`${a.title} ·`)));
  if (!a || a.app !== "claude" || a.binding === "launch") return null;
  return { address: a.address, role: a.role, ...(a.role === "builder" ? parseWork(t.slice(a.title.length).replace(/^\s*·\s*/, ""), cfg) : { work: "role" }) };
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ClaudeLive {
  pid: number;
  sessionId: string;
  hostSessionId?: string;
  name?: string;
  status?: string;
  updatedAt?: number;
  messagingSocketPath?: string;
}

export function readClaudeLive(cfg: Config): ClaudeLive[] {
  if (!existsSync(cfg.claudeLiveDir)) return [];
  const out: ClaudeLive[] = [];
  for (const file of readdirSync(cfg.claudeLiveDir)) {
    if (!/^\d+\.json$/.test(file)) continue;
    const live = readJson<ClaudeLive>(join(cfg.claudeLiveDir, file));
    if (live?.pid && pidAlive(live.pid)) out.push(live);
  }
  return out;
}

interface ClaudeDesktopSession {
  sessionId: string;
  title?: string;
  isArchived?: boolean;
  lastActivityAt?: number;
}

function readClaudeDesktop(cfg: Config): ClaudeDesktopSession[] {
  const out: ClaudeDesktopSession[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || !existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (/^local_.+\.json$/.test(entry.name)) {
        const session = readJson<ClaudeDesktopSession>(path);
        if (session?.sessionId) out.push(session);
      }
    }
  };
  walk(cfg.claudeDesktopDir, 0);
  return out;
}

export function claudeAgents(cfg: Config): Agent[] {
  if (cfg.project && !cfg.project.agents.some((a) => a.app === "claude" && a.binding !== "launch")) return [];
  const live = readClaudeLive(cfg);
  const liveByHost = new Map(live.filter((l) => l.hostSessionId).map((l) => [l.hostSessionId!, l]));
  const seen = new Set<string>();
  const agents: Agent[] = [];
  const add = (ref: string, title: string, lastActive: number | null, l: ClaudeLive | undefined) => {
    const parsed = parseClaudeTitle(title, cfg);
    if (!parsed) return;
    agents.push({
      ...parsed,
      app: "claude",
      title,
      presence: l ? (l.status === "busy" ? "busy" : "idle") : "closed",
      lastActive: Math.max(lastActive ?? 0, l?.updatedAt ?? 0) || null,
      ref,
      pid: l?.pid,
      socket: l?.messagingSocketPath,
      duplicates: [],
    });
  };
  for (const session of readClaudeDesktop(cfg)) {
    if (session.isArchived) continue;
    const l = liveByHost.get(session.sessionId);
    seen.add(session.sessionId);
    add(session.sessionId, (l?.name ?? session.title ?? "").trim(), session.lastActivityAt ?? null, l);
  }
  // Terminal (CLI) sessions have no desktop record.
  for (const l of live) {
    const ref = l.hostSessionId ?? l.sessionId;
    if (seen.has(ref)) continue;
    add(ref, (l.name ?? "").trim(), l.updatedAt ?? null, l);
  }
  return agents;
}

export interface CodexMap {
  /** canonical address → thread id */
  threads: Map<string, string>;
  /** alias (any case) → canonical address */
  aliases: Map<string, string>;
}

export function readCodexMap(cfg: Config): CodexMap {
  const threads = new Map<string,string>();
  for (const a of cfg.project.agents) if (a.app === "codex" && a.binding !== "launch") threads.set(a.address, a.threadId);
  return { threads, aliases: new Map(Object.entries(cfg.project.aliases ?? {}).map(([key,value]) => [key.toLowerCase(),value])) };
}

interface CodexThread {
  id: string;
  name: string | null;
  title: string;
  archived: number;
  recency_at_ms: number;
  rollout_path: string;
}

function readCodexThreads(cfg: Config, ids: string[]): Map<string, CodexThread> {
  const out = new Map<string, CodexThread>();
  if (!existsSync(cfg.codexStateDb) || ids.length === 0) return out;
  let db: Database | undefined;
  try {
    db = new Database(cfg.codexStateDb, { readonly: true });
    db.exec("pragma busy_timeout = 2000");
    const rows = db
      .query<CodexThread, string[]>(
        `select id, name, title, archived, recency_at_ms, rollout_path from threads where id in (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids);
    for (const row of rows) out.set(row.id, row);
  } catch {
    // Codex may be migrating its index; the directory degrades to the map alone.
  } finally {
    db?.close();
  }
  return out;
}

/** A Codex thread is mid-turn when its rollout's last task_started has no later task_complete. */
export function codexTurnRunning(rolloutPath: string, now = Date.now()): boolean | null {
  try {
    const stat = statSync(rolloutPath);
    if (now - stat.mtimeMs > 30 * 60_000) return null;
    const size = Math.min(stat.size, 512 * 1024);
    const fd = openSync(rolloutPath, "r");
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, stat.size - size);
    closeSync(fd);
    const tail = buf.toString("utf8");
    const started = tail.lastIndexOf('"type":"task_started"');
    const ended = Math.max(tail.lastIndexOf('"type":"task_complete"'), tail.lastIndexOf('"type":"turn_aborted"'));
    if (started < 0 && ended < 0) return null;
    return started > ended;
  } catch {
    return null;
  }
}

function codexRole(address: string, cfg: Config): Role {
  return cfg.project.agents.find((a) => a.address === address && a.app === "codex")?.role ?? "expert";
}

export function codexAgents(cfg: Config, now = Date.now()): Agent[] {
  const map = readCodexMap(cfg);
  if (!map.threads.size) return [];
  const threads = readCodexThreads(cfg, [...map.threads.values()]);
  const agents: Agent[] = [];
  for (const [address, threadId] of map.threads) {
    const thread = threads.get(threadId);
    const title = (thread?.name ?? thread?.title ?? "").trim();
    const role = codexRole(address, cfg);
    const work = role === "builder" ? parseWork(title.startsWith(`${address} ·`) ? title.slice(address.length + 2).trim() : title, cfg) : { work: "role" as const };
    const running = thread && !thread.archived ? codexTurnRunning(thread.rollout_path, now) : null;
    agents.push({
      address,
      app: "codex",
      role,
      title: title || "(thread not found)",
      ...work,
      presence: !thread || thread.archived ? "closed" : running === null ? "unknown" : running ? "busy" : "idle",
      lastActive: thread?.recency_at_ms || null,
      ref: threadId,
      duplicates: [],
    });
  }
  return agents;
}

function launchAgents(cfg: Config, now: number): Agent[] {
  let db: Database | undefined;
  const connected = new Set<string>();
  try {
    if (existsSync(cfg.db)) {
      db = new Database(cfg.db, { readonly: true });
      for (const row of db.query<{ref:string},[number]>("select ref from servers where seen_at > ?").all(now - 30000)) connected.add(row.ref);
    }
  } catch { /* No active mailbox yet. */ } finally { db?.close(); }
  return cfg.project.agents.filter(a => a.binding === "launch").map(a => ({
    address:a.address,app:a.app,role:a.role,title:a.address,work:"role",ref:`launch:${a.app}:${a.address}`,
    presence:connected.has(`launch:${a.app}:${a.address}`) ? "connected" : "closed",lastActive:null,duplicates:[],manualInbox:true,
  }));
}

export class Directory {
  private cache: { at: number; agents: Agent[] } | null = null;
  constructor(private cfg: Config) {}
  humanAddress(): string | null { return humanAddress(this.cfg); }
  operatorAddress(): string | null { return operatorAddress(this.cfg); }

  all(maxAgeMs = 2_000): Agent[] {
    const now = Date.now();
    if (this.cache && now - this.cache.at < maxAgeMs) return this.cache.agents;
    const agents = dedupe([...claudeAgents(this.cfg), ...codexAgents(this.cfg, now), ...launchAgents(this.cfg, now)]);
    this.cache = { at: now, agents };
    return agents;
  }


  resolve(input: string): Agent | null {
    const wanted = input.trim().toLowerCase().replace(/\s+/g, " ");
    const agents = this.all();
    if (this.cfg.project) {
      const target = Object.entries(this.cfg.project.aliases ?? {}).find(([alias]) => alias.toLowerCase() === wanted)?.[1].toLowerCase() ?? wanted;
      return agents.find((a) => a.address.toLowerCase() === target) ?? null;
    }
    return null;
  }

  coordinator(app: App): Agent | null {
    const routes = this.cfg.project.coordinators;
    const address = routes[app] ?? routes[app === "claude" ? "codex" : "claude"];
    return address ? this.all().find((a) => a.address === address && a.role === "coordinator") ?? null : null;
  }

  codexThread(address: string): string | null {
    return readCodexMap(this.cfg).threads.get(address) ?? null;
  }
}

/** One row per address: an open chat wins, then the most recently active. */
function dedupe(agents: Agent[]): Agent[] {
  const byAddress = new Map<string, Agent[]>();
  for (const agent of agents) {
    const key = `${agent.app}:${agent.address}`;
    byAddress.set(key, [...(byAddress.get(key) ?? []), agent]);
  }
  const out: Agent[] = [];
  for (const group of byAddress.values()) {
    group.sort((a, b) => Number(b.presence !== "closed") - Number(a.presence !== "closed") || (b.lastActive ?? 0) - (a.lastActive ?? 0));
    const [primary, ...rest] = group;
    primary!.duplicates = rest.map((r) => r.ref);
    out.push(primary!);
  }
  return out.sort((a, b) => a.app.localeCompare(b.app) || order(a) - order(b) || a.address.localeCompare(b.address, "en", { numeric: true }));
}

function order(agent: Agent): number {
  return { coordinator: 0, builder: 1, expert: 2, relay: 3 }[agent.role];
}
