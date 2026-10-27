import { loadConfig } from "./config";
import { Directory } from "./directory";
import { clock, formatAgents } from "./mail";
import { openStore, verifyChain } from "./store";
import { routingCoordinators } from "./context";
import { telegramStatus } from "./telegram";
import { setOperator } from "./operator";

const cfg = loadConfig(), db = openStore(cfg.db, routingCoordinators(cfg));
const [command = "help", arg] = process.argv.slice(2);
try {
  switch (command) {
    case "agents": console.log(formatAgents(new Directory(cfg).all(0), db, cfg, null)); break;
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
