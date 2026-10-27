// Sender selection comes from trusted launch configuration (a shared persona) or an optional native binding, never a tool argument.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import { parseClaudeTitle, readCodexMap, type ClaudeLive, type Role } from "./directory";
import type { App } from "./store";

export interface Caller {
  app: App;
  /** null when the chat's title (Claude) or thread (Codex) isn't an Sideband address yet. */
  address: string | null;
  role: Role | null;
  ref: string;
  title: string;
  /** Claude only: the session's own inbox socket, used to wake it. */
  socket?: string;
  sessionPid?: number;
  problem?: string;
}

function parentOf(pid: number): number | null {
  const out = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const parent = Number(out.stdout.toString().trim());
  return Number.isFinite(parent) && parent > 1 ? parent : null;
}

/** Finds the nearest ancestor that is a Claude Code session (usually the direct parent). */
export function findClaudeSessionPid(cfg: Config, start = process.ppid, maxDepth = 6): number | null {
  let pid: number | null = start;
  for (let depth = 0; pid && depth < maxDepth; depth += 1) {
    if (existsSync(join(cfg.claudeLiveDir, `${pid}.json`))) return pid;
    pid = parentOf(pid);
  }
  return null;
}

export function claudeCaller(cfg: Config, sessionPid: number): Caller {
  let live: ClaudeLive | null = null;
  try {
    live = JSON.parse(readFileSync(join(cfg.claudeLiveDir, `${sessionPid}.json`), "utf8")) as ClaudeLive;
  } catch {
    live = null;
  }
  const title = (live?.name ?? "").trim();
  const parsed = parseClaudeTitle(title, cfg);
  return {
    app: "claude",
    address: parsed?.address ?? null,
    role: parsed?.role ?? null,
    ref: live?.hostSessionId ?? live?.sessionId ?? `pid:${sessionPid}`,
    title,
    socket: live?.messagingSocketPath ?? process.env.CLAUDE_CODE_MESSAGING_SOCKET,
    sessionPid,
    problem: parsed
      ? undefined
      : "This host session title has no configured Sideband identity.",
  };
}

export function codexCaller(cfg: Config, threadId: string, threadTitle = ""): Caller {
  const map = readCodexMap(cfg);
  const address = [...map.threads].find(([, id]) => id === threadId)?.[0] ?? null;
  const role: Role | null = address ? cfg.project.agents.find((a) => a.app === "codex" && a.address === address)?.role ?? null : null;
  return {
    app: "codex",
    address,
    role,
    ref: threadId,
    title: threadTitle,
    problem: address ? undefined : "This host thread has no configured Sideband identity.",
  };
}

/** Pulls the calling Codex thread id out of a tools/call `_meta`, if present. */
export function codexThreadFromMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  if (typeof m.threadId === "string") return m.threadId;
  const turn = m["x-codex-turn-metadata"];
  if (turn && typeof turn === "object" && typeof (turn as Record<string, unknown>).thread_id === "string") {
    return (turn as Record<string, string>).thread_id!;
  }
  return null;
}

/** Local launch configuration is an administrator-chosen shared persona, not per-chat authentication. */
export function launchCaller(cfg: Config, clientName: string): Caller | null {
  if (cfg.launchAgent === undefined) return null;
  const agent = cfg.project.agents.find(a => a.address === cfg.launchAgent && a.binding === "launch");
  const app = /codex/i.test(clientName) ? "codex" : /claude/i.test(clientName) ? "claude" : null;
  const valid = agent && app === agent.app;
  return { app: agent?.app ?? "codex", address: valid ? agent.address : null, role: valid ? agent.role : null,
    ref: agent ? `launch:${agent.app}:${agent.address}` : "unregistered", title: agent?.address ?? "",
    problem: valid ? undefined : "The configured launch persona does not match this client. Client names are compatibility metadata, not authentication." };
}
