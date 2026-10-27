#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { hostname } from "node:os";
import { loadConfig, LIMITS } from "./config";
import { Directory } from "./directory";
import { claudeCaller, codexCaller, codexThreadFromMeta, findClaudeSessionPid, launchCaller, type Caller } from "./identity";
import { ack, formatAgents, inbox, outbox, readThread, sendMail, MailError } from "./mail";
import { heartbeat, KINDS, logEvent, openStore } from "./store";
import { followUpCodex, ringCodex, wakeSelfClaude } from "./wake";
import { deliverToHuman, pollHuman, telegramConfigured } from "./telegram";
import { routeMail, operatorContext } from "./operator";
import { routingCoordinators, authorityNote } from "./context";
import { VERSION } from "./version";

const cfg = loadConfig(), db = openStore(cfg.db, routingCoordinators(cfg)), directory = new Directory(cfg);
const started = Date.now(), holder = `${hostname()}:${process.pid}`;
const sessionPid = cfg.launchAgent || !cfg.project.agents.some(a => a.app === "claude" && a.binding !== "launch") ? null : findClaudeSessionPid(cfg, process.ppid, 2);
let active = false, closing = false, ticking = false;
let timer: ReturnType<typeof setInterval> | undefined;
let caller: Caller | null = null;
const str = { type: "string" } as const;
const definition = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } });
const tools = [
  definition("agents", "List registered personas and connection/native status; also shows this caller. Connection status is not model activity.", {}),
  definition("send", "Send a structured state change to registered recipients. Sender comes from launch configuration or a native binding, never a tool argument. Queue/read/completion are separate.", { to: { oneOf: [str, { type: "array", items: str, maxItems: 4 }] }, kind: { type: "string", enum: [...KINDS] }, reply: { type: "string", enum: ["required", "none"] }, summary: { type: "string", maxLength: LIMITS.summaryChars }, body: { type: "string", maxLength: LIMITS.bodyChars }, ticket: str, reply_to: str }, ["to", "kind", "reply", "summary"]),
  definition("forward", "Forward visible original mail unchanged; optional short note. Never turns teammate mail into human approval.", { id: str, to: str, kind: { type: "string", enum: [...KINDS] }, note: { type: "string", maxLength: LIMITS.ackChars } }, ["id", "to"]),
  definition("inbox", "Read current unread mail, urgent first. Marks shown mail read. Manual launch personas retrieve their mail here; no automatic wake is promised.", { limit: { type: "integer", minimum: 1, maximum: 100 } }),
  definition("read", "Read one visible message and the part of its thread this caller sent or received.", { id: str }, ["id"]),
  definition("ack", "Mark visible mail handled. Does not send a new message or wake anyone.", { id: str, note: { type: "string", maxLength: LIMITS.ackChars } }, ["id"]),
  definition("outbox", "Read your actual queued/read/handled delivery receipts; a queue receipt is not recipient completion.", { limit: { type: "integer", minimum: 1, maximum: 100 } }),
  ...(cfg.project.operator ? [
    definition("routing_context", "Configured Operator only: inspect intake and its explicit related parent.", { id: str }, ["id"]),
    definition("route", "Configured Operator only: route original intake once. FYI stays silent; unavailable steering reports a queue fallback.", { id: str, to: str, mode: { type: "string", enum: ["queue", "steer", "silent"] }, reason: { type: "string", maxLength: 200 } }, ["id", "to", "mode", "reason"]),
  ] : []),
];
const instructions = `Sideband local mail for ${cfg.project.name}. ${authorityNote(cfg)} Sender is selected by trusted launch configuration or an optional native binding, never by tool arguments. A launch persona is shared by all chats using its registration; clientInfo names are self-reported compatibility metadata, not authentication. Use agents to inspect your persona. Use ack for receipt and forward to preserve original messages. Basic launch mode uses manual inbox reads; native wake adapters are optional and version-sensitive. Human transport verification never substitutes for the project's acting-user approval rules.`;
const server = new Server({ name: "sideband", version: VERSION }, { capabilities: { tools: {} }, instructions });
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
function identify(meta: unknown): Caller {
  const name = server.getClientVersion()?.name ?? "";
  const launch = launchCaller(cfg, name);
  if (launch) return launch;
  const thread = codexThreadFromMeta(meta);
  if (/codex/i.test(name) && thread) return codexCaller(cfg, thread, directory.all().find(a => a.ref === thread)?.title ?? "");
  if (/claude/i.test(name) && sessionPid) return claudeCaller(cfg, sessionPid);
  return { app: /claude/i.test(name) ? "claude" : "codex", address: null, role: null, ref: "unregistered", title: "", problem: "No configured identity. Set a registered SIDEBAND_AGENT in the client launch configuration or configure a supported native binding." };
}
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const tool = tools.find(t => t.name === request.params.name);
  if (!tool) return { ...text("Unknown tool"), isError: true };
  let requestCaller: Caller | null = null;
  try {
    requestCaller = identify(request.params._meta);
    const args = request.params.arguments ?? {};
    if (Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties, key))) throw new MailError("Unsupported argument; sender identity cannot be selected by a tool argument.");
    caller = requestCaller;
    if (caller.address) { active = true; heartbeat(db, process.pid, caller.app, caller.ref, caller.address, started); }
    const limit = Math.max(1, Math.min(100, Number(args.limit ?? 10) || 10));
    switch (tool.name) {
      case "agents": return text(formatAgents(directory.all(0), db, cfg, caller));
      case "send": {
        const sent = sendMail(db, cfg, directory, caller, args as never); void tick();
        return text(`Sent as ${caller.address}.\n${sent.deliveries.map(d => `${d.id} → ${d.to}: ${d.outlook}`).join("\n")}`);
      }
      case "forward": {
        const sent = sendMail(db, cfg, directory, caller, { to: String(args.to ?? ""), kind: args.kind as never, reply: "none", summary: "", forward_of: String(args.id ?? ""), note: args.note as string | undefined }); void tick();
        return text(sent.deliveries.map(d => `${d.id} → ${d.to}: ${d.outlook}`).join("\n"));
      }
      case "inbox": return text(inbox(db, cfg, caller, limit));
      case "read": return text(readThread(db, cfg, caller, String(args.id ?? "")));
      case "ack": return text(ack(db, caller, String(args.id ?? ""), args.note as string | undefined));
      case "outbox": return text(outbox(db, cfg, caller, limit));
      case "routing_context": return text(JSON.stringify(operatorContext(db, directory, caller, String(args.id ?? ""))));
      case "route": return text(JSON.stringify(routeMail(db, directory, caller, args as never)));
      default: return { ...text("Unknown tool"), isError: true };
    }
  } catch (error) {
    if (error instanceof MailError) logEvent(db, requestCaller?.address ?? "unregistered", "refused", null, { reason: error.message });
    return { ...text(error instanceof Error ? error.message : "Mail request failed"), isError: true };
  }
});
async function tick() {
  if (!active || closing || ticking) return;
  ticking = true;
  try {
    if (caller?.address) heartbeat(db, process.pid, caller.app, caller.ref, caller.address, started);
    if (caller?.socket && caller.address) await wakeSelfClaude(db, cfg, caller.address, caller.socket);
    await ringCodex(db, cfg, directory, holder);
    await followUpCodex(db, cfg, directory);
    if (telegramConfigured(cfg)) { await deliverToHuman(db, cfg, holder); await pollHuman(db, cfg, directory, holder, 1); }
  } catch { if (!closing) console.error("Sideband background delivery failed; inspect local receipts."); }
  finally { ticking = false; }
}
function stop() {
  if (closing) return;
  closing = true; if (timer) clearInterval(timer);
  try { db.query("delete from servers where pid=?").run(process.pid); db.close(); } finally { process.exit(0); }
}
server.onclose = stop;
process.on("SIGINT", stop); process.on("SIGTERM", stop);
process.stdin.on("end", stop); process.stdin.on("close", stop);
await server.connect(new StdioServerTransport());
timer = setInterval(() => void tick(), 2000);
