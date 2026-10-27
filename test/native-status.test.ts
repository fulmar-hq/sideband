import{expect,test}from"bun:test";import{writeFileSync}from"node:fs";import{join}from"node:path";import{standardWorld}from"./fixture";
test("unrecognized native turn metadata is unknown, not proof of idle",()=>{const w=standardWorld();writeFileSync(join(w.dir,"rollout-t-helper.jsonl"),'{"type":"metadata","payload":{}}\n');expect(w.directory.all(0).find(a=>a.address==="Helper")!.presence).toBe("unknown");w.db.close();});

test("native follow-up requires positive idle evidence; unknown, closed and manual are never opened",async()=>{
 const{unlinkSync,utimesSync}=await import("node:fs");const{Database}=await import("bun:sqlite");const{followUpCodex}=await import("../src/wake");const{heartbeat}=await import("../src/store");
 for(const mode of["missing","stale","malformed","closed","manual"]){
  const w=standardWorld(),now=Date.now(),file=join(w.dir,"rollout-t-helper.jsonl");let ref="t-helper";
  if(mode==="missing")unlinkSync(file);
  if(mode==="stale")utimesSync(file,new Date(now-31*60000),new Date(now-31*60000));
  if(mode==="malformed")writeFileSync(file,'{"type":"metadata","payload":{}}\n');
  if(mode==="closed")w.codexThread({address:"Helper",id:ref,name:"free",archived:true});
  if(mode==="manual"){w.cfg.project.agents=w.cfg.project.agents.map(a=>a.address==="Helper"?{address:"Helper",role:"builder",app:"codex",binding:"launch"}:a);ref="launch:codex:Helper";heartbeat(w.db,99999,"codex",ref,"Helper",now,now);}
  const queue=new Database(w.cfg.codexQueueDb);queue.query("insert into queued_items values('synthetic',?,'{}',?)").run(ref,now-60000);queue.close();let calls=0;
  await followUpCodex(w.db,w.cfg,w.directory,now,async()=>{calls++;return{ok:true,detail:"synthetic"};});if(calls)throw Error(`Unexpected open for ${mode}: `+JSON.stringify(w.directory.all(0).find(a=>a.address==="Helper")));expect(calls).toBe(0);w.db.close();
 }
});
