import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function client(file:string, persona:string|undefined, app:string) {
  const child=Bun.spawn([process.execPath,join(import.meta.dir,"../src/sideband.ts"),"serve","--config",file],{env:{...process.env,SIDEBAND_AGENT:persona},stdin:"pipe",stdout:"pipe",stderr:"pipe"});
  const reader=child.stdout.getReader();let buffer="",serial=0;const replies=new Map<number,any>();
  function write(value:object){child.stdin.write(JSON.stringify({jsonrpc:"2.0",...value})+"\n");child.stdin.flush();}
  async function response(id:number){const timer=setTimeout(()=>child.kill("SIGTERM"),5000);try{while(!replies.has(id)){const{value,done}=await reader.read();if(done)throw Error("Synthetic MCP client closed before response: "+(await new Response(child.stderr).text()).slice(0,500));buffer+=new TextDecoder().decode(value);let i;while((i=buffer.indexOf("\n"))>=0){const row=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(row.id!==undefined)replies.set(row.id,row);}}return replies.get(id).result;}finally{clearTimeout(timer);}}
  write({id:++serial,method:"initialize",params:{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:app,version:"synthetic"}}});await response(serial);write({method:"notifications/initialized"});
  return{call:async(name:string,args:object={},meta:object={})=>{const id=++serial;write({id,method:"tools/call",params:{name,arguments:args,_meta:meta}});return response(id);},close:async()=>{child.stdin.end();await child.exited;}};
}

test("two ordinary stdio clients send/read/ack with configured shared personas and no native registry",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"sideband-personas-")),file=join(dir,"sideband.json"),dbPath=join(dir,"state","mail.sqlite");
  writeFileSync(file,JSON.stringify({version:1,name:"Fixture",authority:"repository issues",tickets:["#"],agents:[{address:"Planner",app:"claude",role:"coordinator",binding:"launch"},{address:"Engineer",app:"codex",role:"builder",binding:"launch"}],coordinators:{claude:"Planner",codex:null},paths:{db:dbPath,claudeLiveDir:join(dir,"absent-sessions"),claudeDesktopDir:join(dir,"absent-desktop"),codexStateDb:join(dir,"absent-threads"),codexQueueDb:join(dir,"absent-queue"),codexBin:"/bin/false"}}));
  const clients:Awaited<ReturnType<typeof client>>[]=[];
  try{
    const [planner,engineer]=await Promise.all([client(file,"Planner","claude-code"),client(file,"Engineer","codex-mcp-client")]);clients.push(planner,engineer);
    expect((await planner.call("agents")).content[0].text).toContain("You are Planner (Claude)");
    expect((await engineer.call("agents")).content[0].text).toContain("You are Engineer (Codex)");
    const spoof=await planner.call("send",{to:"Engineer",from:"Engineer",kind:"action",reply:"none",summary:"Must refuse"});expect(spoof.isError).toBe(true);
    const sent=await planner.call("send",{to:"Engineer",kind:"handoff",reply:"required",summary:"Synthetic review ready"},{threadId:"attempted-other-binding"});expect(sent.isError).toBeUndefined();expect(sent.content[0].text).toContain("Sent as Planner");expect(sent.content[0].text).toContain("manual inbox reads");expect(sent.content[0].text).not.toContain("waking");
    const received=await engineer.call("inbox");expect(received.content[0].text).toContain("Synthetic review ready");expect(received.content[0].text).toContain("from Planner (Claude)");
    const id=received.content[0].text.match(/m_[a-z0-9]+/)![0];expect((await engineer.call("ack",{id})).isError).toBeUndefined();
    const samePersona=await client(file,"Planner","claude-code");clients.push(samePersona);
    expect((await samePersona.call("agents")).content[0].text).toContain("You are Planner (Claude)");
    expect((await samePersona.call("read",{id})).content[0].text).toContain("Synthetic review ready");
    const missing=await client(file,undefined,"codex-mcp-client"),mismatch=await client(file,"Planner","codex-mcp-client");clients.push(missing,mismatch);
    for(const c of[missing,mismatch])expect((await c.call("send",{to:"Engineer",kind:"action",reply:"none",summary:"Must refuse"})).isError).toBe(true);
    const db=new Database(dbPath,{readonly:true});expect(db.query<{n:number},[]>("select count(*) n from messages").get()!.n).toBe(1);expect(db.query("select * from wakes").all()).toEqual([]);db.close();
  }finally{await Promise.all(clients.map(c=>c.close()));rmSync(dir,{recursive:true,force:true});}
});

test("an unregistered launch environment refuses startup before creating a store",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"sideband-unregistered-")),file=join(dir,"sideband.json");
 try{
  writeFileSync(file,JSON.stringify({version:1,name:"Fixture",authority:"repository issues",tickets:["#"],agents:[],coordinators:{claude:null,codex:null}}));
  const child=Bun.spawn([process.execPath,join(import.meta.dir,"../src/sideband.ts"),"serve","--config",file],{env:{...process.env,SIDEBAND_AGENT:"Unregistered"},stdout:"pipe",stderr:"pipe"});
  expect(await child.exited).not.toBe(0);expect(await new Response(child.stderr).text()).toContain("Unknown Sideband launch persona");
  const{existsSync}=await import("node:fs");expect(existsSync(join(dir,"state","mail.sqlite"))).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
