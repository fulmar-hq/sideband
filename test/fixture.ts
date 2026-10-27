import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config";
import { Directory, type Role } from "../src/directory";
import { claudeCaller, codexCaller, type Caller } from "../src/identity";
import { openStore, configureCoordinators } from "../src/store";
import type { AgentBinding } from "../src/project-config";

export const DEAD_PID = 999_999;
export interface World {
  dir:string; cfg:Config; db:Database; directory:Directory;
  claudeSession(opts:{pid:number;host:string;title:string;address?:string;role?:Role;status?:"idle"|"busy";socket?:string}):void;
  claudeDesktop(opts:{host:string;title:string;address?:string;role?:Role;archived?:boolean;lastActivityAt?:number}):void;
  codexThread(opts:{address?:string;role?:Role;id:string;name:string;archived?:boolean;running?:boolean}):void;
  claude(pid:number):Caller;codex(id:string):Caller;
}
export function makeWorld():World {
  const dir=mkdtempSync(join(tmpdir(),"sideband-test-"));
  const cfg:Config={project:{version:1,name:"Test project",authority:"repository issues",tickets:["TASK-","#"],human:"Owner",telegram:{envFile:join(dir,"telegram.env")},agents:[],coordinators:{claude:null,codex:null}},db:join(dir,"mail.sqlite"),claudeLiveDir:join(dir,"sessions"),claudeDesktopDir:join(dir,"desktop"),codexStateDb:join(dir,"threads.sqlite"),codexQueueDb:join(dir,"queue.sqlite"),codexBin:"/bin/false",timeZone:"UTC",digestTimes:["12:00","17:00"],telegramEnv:join(dir,"telegram.env"),telegramApi:"http://127.0.0.1:9",coordinatorDigestMinutes:0};
  cfg.project.paths={db:cfg.db,claudeLiveDir:cfg.claudeLiveDir,claudeDesktopDir:cfg.claudeDesktopDir,codexStateDb:cfg.codexStateDb,codexQueueDb:cfg.codexQueueDb,codexBin:cfg.codexBin};
  mkdirSync(cfg.claudeLiveDir);mkdirSync(join(cfg.claudeDesktopDir,"org","user"),{recursive:true});
  const index=new Database(cfg.codexStateDb,{create:true});index.exec("create table threads(id text primary key,name text,title text not null default '',archived integer not null default0,recency_at_ms integer not null default0,rollout_path text not null)".replaceAll("default0","default 0"));index.close();
  const queue=new Database(cfg.codexQueueDb,{create:true});queue.exec("create table queued_items(id text primary key,thread_id text not null,payload_json text not null,created_at_ms integer not null)");queue.close();
  const db=openStore(cfg.db,[]),directory=new Directory(cfg);
  function register(binding:AgentBinding){const at=cfg.project.agents.findIndex(a=>a.address===binding.address);if(at<0)cfg.project.agents.push(binding);else cfg.project.agents[at]=binding;if(binding.role==="coordinator")cfg.project.coordinators[binding.app]=binding.address;configureCoordinators(db,Object.values(cfg.project.coordinators).filter((x):x is string=>x!==null));}
  return{dir,cfg,db,directory,
    claudeSession({pid,host,title,address=title.split("·")[0]!.trim(),role="builder",status="idle",socket}){register({address,role,app:"claude",title:title.split("·")[0]!.trim()});writeFileSync(join(cfg.claudeLiveDir,`${pid}.json`),JSON.stringify({pid,sessionId:`session-${host}`,hostSessionId:host,name:title,status,updatedAt:Date.now(),messagingSocketPath:socket??join(dir,`${pid}.sock`)}));},
    claudeDesktop({host,title,address=title.split("·")[0]!.trim(),role="builder",archived=false,lastActivityAt=Date.now()-60000}){register({address,role,app:"claude",title:title.split("·")[0]!.trim()});writeFileSync(join(cfg.claudeDesktopDir,"org","user",`${host}.json`),JSON.stringify({sessionId:host,title,isArchived:archived,lastActivityAt}));},
    codexThread({address,role="builder",id,name,archived=false,running=false}){const rollout=join(dir,`rollout-${id}.jsonl`);writeFileSync(rollout,running?'{"type":"event_msg","payload":{"type":"task_complete"}}\n{"type":"event_msg","payload":{"type":"task_started"}}\n':'{"type":"event_msg","payload":{"type":"task_started"}}\n{"type":"event_msg","payload":{"type":"task_complete"}}\n');const d=new Database(cfg.codexStateDb);d.query("insert or replace into threads(id,name,title,archived,recency_at_ms,rollout_path) values(?,?,'',?,?,?)").run(id,name,archived?1:0,Date.now(),rollout);d.close();if(address)register({address,app:"codex",role,threadId:id});},
    claude(pid){return claudeCaller(cfg,pid);},codex(id){return codexCaller(cfg,id);},
  };
}
export function standardWorld():World&{pids:{coordinator:number;b10:number;b4:number}}{
  const w=makeWorld(),pids={coordinator:process.pid,b10:process.ppid,b4:DEAD_PID};
  w.claudeDesktop({host:"local_planner",title:"Planner",role:"coordinator"});w.claudeSession({pid:pids.coordinator,host:"local_planner",title:"Planner",role:"coordinator"});
  w.claudeDesktop({host:"local_worker",title:"Worker One · Review · TASK-6"});w.claudeSession({pid:pids.b10,host:"local_worker",title:"Worker One · Review · TASK-6",status:"busy"});
  w.claudeDesktop({host:"local_helper",title:"Worker Two · free"});w.codexThread({address:"Lead",role:"coordinator",id:"t-lead",name:"Planning"});w.codexThread({address:"Developer",id:"t-developer",name:"Review · TASK-6",running:true});w.codexThread({address:"Helper",id:"t-helper",name:"free"});
  w.cfg.project.aliases={"Former Developer":"Developer"};return Object.assign(w,{pids});
}
