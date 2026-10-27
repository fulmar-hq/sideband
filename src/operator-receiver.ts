#!/usr/bin/env bun
// Dedicated current-version ingress. No model calls, synthetic Telegram messages or outgoing sender.
import { fenceLegacyDelivery } from "./operator";
export const RECEIVER_VERSION = 100 + POLL_VERSION;
import { hostname } from "node:os";
import { loadConfig } from "./config";
import { routingCoordinators } from "./context";
import { Directory } from "./directory";
import { openStore, logEvent } from "./store";
import { pollHuman, takePollLease, takeVersionedLease, POLL_VERSION } from "./telegram";
import { ringCodex, followUpCodex } from "./wake";

if (import.meta.main) {
  const cfg=loadConfig(); const db=openStore(cfg.db,routingCoordinators(cfg)); const directory=new Directory(cfg);
  const holder=`${hostname()}:operator-receiver:${process.pid}`;
  let stopping=false;
  process.on("SIGTERM",()=>{stopping=true;}); process.on("SIGINT",()=>{stopping=true;});
  // Fence older pollers before activation; allow their already-running long poll to drain.
  takePollLease(db,holder,Date.now(),RECEIVER_VERSION);
  fenceLegacyDelivery(db);
  logEvent(db,holder,"operator-receiver-start",null,{version:RECEIVER_VERSION});
  const readyAt=Date.now()+36000;
  const ringHolder=`${holder}#v${RECEIVER_VERSION}`;
  // Version-fence old ringers as well: unknown queue outcomes must not be blindly retried by old code.
  if(!takeVersionedLease(db,"codex-ringer",RECEIVER_VERSION,holder,60000)) throw new Error("A newer ringer owns delivery");
  let ringing=false;
  const timer=setInterval(async()=>{
    if(stopping || ringing || Date.now()<readyAt)return;
    ringing=true;
    try { await ringCodex(db,cfg,directory,ringHolder); await followUpCodex(db,cfg,directory); }
    catch {logEvent(db,holder,"operator-ring-error",null,{});}
    finally {ringing=false;}
  },1000);
  while(!stopping) {
    takePollLease(db,holder,Date.now(),RECEIVER_VERSION);
    takeVersionedLease(db,"codex-ringer",RECEIVER_VERSION,holder,60000);
    if(Date.now()>=readyAt) {
      try {await pollHuman(db,cfg,directory,holder,25,Date.now,undefined,RECEIVER_VERSION);}
      catch {logEvent(db,holder,"operator-poll-error",null,{});}
    }
    await Bun.sleep(1000);
  }
  clearInterval(timer);
  while(ringing) await Bun.sleep(50);
  db.close();
}
