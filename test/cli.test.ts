import { afterEach, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeWorld, type World } from "./fixture";

const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) { w.db.close(); rmSync(w.dir,{recursive:true,force:true}); } });
function fixture() {
  const w=makeWorld();worlds.push(w);
  w.codexThread({address:"Planner",role:"coordinator",id:"synthetic-planner",name:"Planner · Review"});
  w.codexThread({address:"Engineer",role:"builder",id:"synthetic-engineer",name:"Engineer · Implementation"});
  w.cfg.project.agents.push({address:"Observer",app:"codex",role:"builder",binding:"launch"});
  const file=join(w.dir,"project.json");writeFileSync(file,JSON.stringify(w.cfg.project));
  const run=async(args:string[],thread:string|null="synthetic-engineer",persona?:string)=>{
    const child=Bun.spawn([process.execPath,join(import.meta.dir,"../src/sideband.ts"),...args,"--config",file],{
      env:{...process.env,SIDEBAND_CONFIG:file,SIDEBAND_AGENT:persona,CODEX_THREAD_ID:thread??undefined},stdout:"pipe",stderr:"pipe",
    });
    const [out,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    return {out,error,code};
  };
  return {w,run};
}
const message={to:"Planner",kind:"handoff",reply:"none",ticket:"TASK-4",summary:"Synthetic handoff ready",body:"Only a temporary test message."};

describe("native mail CLI",()=>{
 it("returns structured directory rows without changing the ordinary text view",async()=>{
  const {run}=fixture();const json=await run(["agents","--json"]);expect(json.code).toBe(0);
  const rows=JSON.parse(json.out);expect(rows.find((r:{address:string})=>r.address==="Engineer")).toMatchObject({app:"codex",role:"builder",ref:"synthetic-engineer"});
  const plain=await run(["agents"]);expect(plain.code).toBe(0);expect(plain.out).toContain("Engineer");expect(plain.out).not.toStartWith("[");
 });
 it("sends through the actual configured native host and preserves the core duplicate fence",async()=>{
  const {w,run}=fixture();const result=await run(["send",JSON.stringify(message)]);expect(result.error).toBe("");expect(result.code).toBe(0);expect(JSON.parse(result.out).sendId).toBeString();
  const duplicate=await run(["send",JSON.stringify(message)]);expect(duplicate.code).not.toBe(0);expect(duplicate.error).toContain("Duplicate:");
  const rows=w.db.query("select sender,sender_ref,recipient,summary from messages").all();
  expect(rows).toEqual([{sender:"Engineer",sender_ref:"synthetic-engineer",recipient:"Planner",summary:message.summary}]);
 });
 it.each([null,"unregistered-thread"])("refuses missing or unknown native context (%s), even with a configured launch persona",async(thread)=>{
  const {w,run}=fixture();const result=await run(["send",JSON.stringify(message)],thread,"Observer");
  expect(result.code).not.toBe(0);expect(result.error).toMatch(/host|thread|identity/i);expect(w.db.query("select count(*) as n from messages").get()).toEqual({n:0});
 });
 it("refuses typed caller fields and malformed message JSON without leaking the supplied text",async()=>{
  const {w,run}=fixture();const spoof=await run(["send",JSON.stringify({...message,from:"Planner",sender:"Planner"})]);expect(spoof.code).not.toBe(0);
  const invalid=await run(["send","private-synthetic-invalid-json"]);expect(invalid.code).not.toBe(0);expect(invalid.error).not.toContain("private-synthetic-invalid-json");
  expect(w.db.query("select count(*) as n from messages").get()).toEqual({n:0});
 });
 it("refuses unsupported native directory flags instead of claiming positive-idle proof",async()=>{
  const {run}=fixture();const result=await run(["agents","--idle-for","Engineer"]);expect(result.code).not.toBe(0);
 });
});
