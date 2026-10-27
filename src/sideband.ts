#!/usr/bin/env bun
import { resolve } from "node:path";
import { loadConfig } from "./config";
import { defaultConfigFile, defaultInstallRoot, initialize, install, shellQuote, type SetupOptions } from "./setup";
import { VERSION } from "./version";

const args = process.argv.slice(2);
function take(name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  if (args.indexOf(name, at + 1) >= 0 || !args[at + 1] || args[at + 1]!.startsWith("--")) throw new Error(`Expected one value for ${name}`);
  const value = args[at + 1]!; args.splice(at, 2); return value;
}
try {
  const file = take("--config") ?? process.env.SIDEBAND_CONFIG ?? defaultConfigFile();
  if (!file.trim()) throw new Error("Choose a nonempty Sideband configuration path");
  const command = args.shift() ?? "help";
  if (command === "--version" || command === "version") console.log(VERSION);
  else if (command === "help" || command === "--help") console.log("sideband install|init [--config <file>] [--name <project>] [--root <install directory>] [--starter-pair]\nsideband doctor|serve|agents|peek <address>|verify [--config <file>]\nConfiguration, host registration and delivery are separate; setup never starts an agent or edits client settings.");
  else if (command === "install" || command === "init") {
    const root = take("--root");
    const starter = args.indexOf("--starter-pair");
    if (starter >= 0) args.splice(starter,1);
    const options: SetupOptions = { starterPair:starter>=0, name: take("--name"), authority: take("--authority"), address: take("--address"), codexThread: take("--codex-thread"), claudeTitle: take("--claude-title") };
    if (args.length || (command === "init" && root)) throw new Error("Unknown setup arguments");
    if (command === "init") {
      const result = initialize(resolve(file), options);
      console.log(`${result.created ? "Created" : "Kept"} ${resolve(file)}; ${result.project.agents.length} host bindings. No delivery was attempted.`);
    } else {
      const result = install(resolve(import.meta.dir, ".."), root ?? defaultInstallRoot(), file, options);
      console.log(`Installed Sideband${result.version}: ${result.binary}\n${result.created ? "Created" : "Kept"} configuration: ${result.configFile}\nProject: ${result.project.name}; ${result.project.agents.length} bindings. No client settings or services changed.\nCheck: ${shellQuote(result.binary)} doctor`);
      const planner=result.project.agents.find(a=>a.app==="claude"&&a.binding==="launch"),engineer=result.project.agents.find(a=>a.app==="codex"&&a.binding==="launch");
      if(planner)console.log(`Claude Code local registration:\nclaude mcp add --scope local --env ${shellQuote(`SIDEBAND_AGENT=${planner.address}`)} --transport stdio sideband -- ${shellQuote(result.binary)} serve --config ${shellQuote(result.configFile)}`);
      if(engineer)console.log(`Codex project configuration (.codex/config.toml):\n[mcp_servers.sideband]\ncommand = ${JSON.stringify(result.binary)}\nargs = ["serve", "--config", ${JSON.stringify(result.configFile)}]\nenv = { SIDEBAND_AGENT = ${JSON.stringify(engineer.address)} }`);

    }
  } else {
    process.env.SIDEBAND_CONFIG = resolve(file); // Never use the legacy Sideband fallback from this entrypoint.
    const cfg = loadConfig();
    if (command === "doctor") console.log(`Sideband${VERSION}; configuration valid\nProject: ${cfg.project!.name}\nConfiguration: ${resolve(file)}\nHost bindings: ${cfg.project!.agents.length}\nTelegram: ${cfg.project!.telegram ? "configured; connection not tested" : "off"}\nHost connections and delivery: not tested. Add bindings in the configuration before sending.`);
    else if (command === "serve") {
      if (args.length) throw new Error("Unknown serve arguments");
      await import("./server");
    } else {
      if (!["agents", "peek", "verify", "telegram", "operator"].includes(command)) throw new Error(`Unknown Sideband command: ${command}`);
      process.argv = [process.argv[0]!, process.argv[1]!, command, ...args]; await import("./cli");
    }
  }
} catch (error) { console.error(error instanceof Error ? error.message : "Sideband command failed"); process.exitCode = 1; }
