import { homedir } from "node:os";
import { join } from "node:path";
import { readProjectConfig, projectPath, PROJECT_PATHS, defaultConfigFile, type ProjectConfig } from "./project-config";

export interface Config {
  project: ProjectConfig;
  launchAgent?: string;
  db: string;
  claudeLiveDir: string;
  claudeDesktopDir: string;
  codexStateDb: string;
  codexBin: string;
  codexQueueDb: string;
  timeZone: string;
  digestTimes: string[];
  telegramEnv: string;
  telegramApi: string;
  coordinatorDigestMinutes: number;
}

export function loadConfig(overrides: Partial<Config> = {}, file = process.env.SIDEBAND_CONFIG ?? defaultConfigFile()): Config {
  if (!file) throw new Error("SIDEBAND_CONFIG must name a configuration file");
  const project = readProjectConfig(file), home = homedir(), state = projectPath("state", file);
  const launchAgent = process.env.SIDEBAND_AGENT;
  if (launchAgent !== undefined && !project.agents.some((a) => a.address === launchAgent && a.binding === "launch")) throw new Error("Unknown Sideband launch persona");
  const paths = Object.fromEntries(PROJECT_PATHS.flatMap((key) => project.paths?.[key] ? [[key, projectPath(project.paths[key]!, file)]] : []));
  return {
    project, launchAgent, db: join(state, "mail.sqlite"),
    claudeLiveDir: join(home, ".claude/sessions"),
    claudeDesktopDir: join(home, "Library/Application Support/Claude/claude-code-sessions"),
    codexStateDb: join(home, ".codex/state_5.sqlite"), codexBin: "codex", codexQueueDb: join(home, ".codex/queue_1.sqlite"),
    timeZone: project.timeZone ?? "UTC", digestTimes: project.digestTimes ?? ["12:00", "17:00"],
    telegramEnv: project.telegram ? projectPath(project.telegram.envFile, file) : join(state, "telegram-disabled.env"),
    telegramApi: "https://api.telegram.org", coordinatorDigestMinutes: project.coordinatorDigestMinutes ?? 0,
    ...paths, ...overrides,
  };
}

export const LIMITS = {
  summaryChars: 120,
  bodyChars: 800,
  ackChars: 200,
  recipientsPerSend: 4,

  perPairPerMinute: 10,

  perSenderPerMinute: 30,

  duplicateWindowMs: 24 * 60 * 60 * 1000,

  threadDepth: 8,

  settleMs: 3_000,

  minWakeGapMs: 60_000,

  failedWakeRetryMs: 5 * 60_000,

  wakeLineItems: 3,

  codexQueueCheckMs: 20_000,

  codexOpenGiveUpMs: 3 * 60_000,

  telegramPollSeconds: 25,
  telegramPollLeaseMs: 40_000,

  telegramRetryMs: 60_000,








} as const;
