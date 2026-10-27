import { loadConfig } from "./config";
import { Directory } from "./directory";
import { clock, formatAgents, sendMail, type SendInput } from "./mail";
import { openStore, verifyChain } from "./store";
import { routingCoordinators } from "./context";
import { telegramStatus } from "./telegram";
import { codexCaller, type Caller } from "./identity";
import { setOperator } from "./operator";

const cfg = loadConfig();
const [command = "help", ...args] = process.argv.slice(2);
const arg = args[0];
let caller: Caller | undefined;
let message: SendInput | undefined;
if (command === "send") {
  // The native host supplies this context. A launch persona or JSON field is
  // never a substitute for a registered native thread in the CLI fallback.
  const ref = process.env.CODEX_THREAD_ID;
  if (!ref?.trim()) throw new Error("Send requires the current native Codex host thread identity.");
  caller = codexCaller(cfg, ref);
  if (!caller.address || caller.problem) throw new Error(caller.problem ?? "Unregistered native host identity.");
  if (args.length !== 1) throw new Error("Send expects one JSON message argument.");
  let parsed: unknown;
  try { parsed = JSON.parse(arg!); } catch { throw new Error("Send expects one JSON message object."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Send expects one JSON message object.");
  if (["from", "sender", "sender_ref", "sender_app", "caller"].some(key => Object.hasOwn(parsed, key)))
    throw new Error("Sender identity comes from the native host, never message fields.");
  message = parsed as SendInput;
}
if (command === "agents" && args.length && !(args.length === 1 && arg === "--json"))
  throw new Error("Agents accepts only --json; positive native idle verification is not available in this CLI version.");
const db = openStore(cfg.db, routingCoordinators(cfg));
try {
  switch (command) {
    case "agents": {
      const agents = new Directory(cfg).all(0);
      console.log(arg === "--json" ? JSON.stringify(agents) : formatAgents(agents, db, cfg, null));
      break;
    }
    case "send": console.log(JSON.stringify(sendMail(db, cfg, new Directory(cfg), caller!, message!))); break;
    case "peek": {
      if (!arg) throw new Error("Usage: sideband peek <address>");
      const rows = db.query<{id:string;sender:string;kind:string;summary:string;body:string;created_at:number;state:string},[string]>("select id,sender,kind,summary,body,created_at,state from messages where recipient=? order by created_at desc limit20".replace("limit20","limit 20")).all(arg).reverse();
      console.log(`Read-only local mail for ${arg}; nothing marked read.`);
      for (const r of rows) console.log(`${r.id} ${clock(r.created_at,cfg)} ${r.kind} from ${r.sender} (${r.state})\n  ${r.summary}${r.body ? `\n  ${r.body}` : ""}`);
      break;
    }
    case "verify": { const result=verifyChain(db); console.log(result.ok ? `Event log intact (${result.checked} events).` : `Event log failed at${result.brokenAt}`); if(!result.ok) process.exitCode=1; break; }
    case "telegram": console.log(telegramStatus(db,cfg)); break;
    case "operator": if(!["on","off"].includes(arg??""))throw new Error("Usage: sideband operator on|off");console.log(JSON.stringify(setOperator(db,new Directory(cfg),arg==="on")));break;
    default: throw new Error("Unknown command. Use sideband --help.");
  }
} finally { db.close(); }
