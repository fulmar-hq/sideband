#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface PrivacyHit { rule:string; line:number; example:boolean }
/** Bounded pattern check, not a claim to recognize every form of personal data. Values are never reported. */
export function findPrivacy(text:string):PrivacyHit[]{
  const hits:PrivacyHit[]=[];
  const rules:[string,RegExp,(value:string)=>boolean][]=[
    ["email",/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,value=>/(?:@|\.)(?:example\.(?:com|org|net)|[^@]*\.(?:invalid|test|example))$/i.test(value)||/@users\.noreply\.github\.com$/i.test(value)||value.toLowerCase()==="noreply@github.com"],
    ["opaque-session-id",/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,value=>value.toLowerCase()==="00000000-0000-4000-8000-000000000000"],
    ["personal-home-path",/\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/[^\s"'`)]*)?/g,()=>false],
    ["ipv4",/\b(?:\d{1,3}\.){3}\d{1,3}\b/g,value=>/^(?:127\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(value)],
    ["phone",/(?<!\w)\+?\d[\d ().-]{8,}\d(?!\w)/g,value=>{const d=value.replace(/\D/g,"");return d==="12025550123"||d==="15145550123";}],
  ];
  for(const[rule,pattern,example]of rules)for(const match of text.matchAll(pattern)){
    if(rule==="phone"){if(/^\d{4}-\d{2}-\d{2}(?:[ T]|$)/.test(match[0]))continue;const d=match[0].replace(/\D/g,"");if(d.length<10||d.length>15)continue;}
    if(rule==="ipv4"&&match[0].split(".").some(n=>Number(n)>255))continue;
    hits.push({rule,line:text.slice(0,match.index).split("\n").length,example:example(match[0])});
  }
  return hits;
}
function git(...args:string[]):string {const p=Bun.spawnSync(["git",...args],{stdout:"pipe",stderr:"pipe"});if(p.exitCode)throw Error("Privacy scan Git input failed");return p.stdout.toString();}
if(import.meta.main){
  try{
    const history=process.argv.includes("--history"),staged=process.argv.includes("--staged");
    if(history&&staged)throw Error("Choose staged or history scan");
    const records:{path:string;text:string}[]=[];
    if(history){
      for(const line of git("rev-list","--objects","--all").trim().split("\n")){
        const match=line.match(/^([a-f0-9]{40}) (.+)$/);if(!match||git("cat-file","-t",match[1]!).trim()!=="blob")continue;
        records.push({path:match[2]!,text:git("cat-file","blob",match[1]!)});
      }
      records.push({path:"Git author/committer metadata",text:git("log","--all","--format=%ae%n%ce")});
    }else for(const path of git("ls-files","-z").split("\0").filter(Boolean))records.push({path,text:staged?git("show",`:${path}`):readFileSync(resolve(path),"utf8")});
    let failures=0,examples=0;
    for(const record of records)for(const hit of findPrivacy(record.text)){if(hit.example){examples++;continue;}failures++;console.error(`${record.path}:${hit.line}: ${hit.rule} (value redacted)`);}
    console.log(`Privacy scan: ${records.length} inputs; ${failures} findings; ${examples} reserved-example/noreply matches.`);if(failures)process.exitCode=1;
  }catch(error){console.error(error instanceof Error?error.message:"Privacy scan failed");process.exitCode=1;}
}
