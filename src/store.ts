// The mail store: one SQLite file shared by every chat's server process (WAL, short busy waits).
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export const KINDS = ["blocker", "decision", "action", "handoff", "fyi"] as const;
export type Kind = (typeof KINDS)[number];
/** FYI never wakes anyone; it waits for the recipient's next inbox or a digest. */
export const WAKING_KINDS: ReadonlySet<Kind> = new Set(["blocker", "decision", "action", "handoff"]);

export type App = "claude" | "codex";

export type Endpoint = App | "telegram";
/** unread → read → acked; superseded when a newer note about the same ticket replaced it unread. */
export type MessageState = "unread" | "read" | "acked" | "superseded";
/** pending → woken | failed (retried); digest → digested; none for superseded rows. */
export type WakeState = "pending" | "woken" | "failed" | "digest" | "digested" | "none";

export interface MessageRow {
  id: string;
  send_id: string;
  created_at: number;
  sender: string;
  sender_app: Endpoint;
  sender_ref: string;
  recipient: string;
  recipient_app: Endpoint;
  routed_from: string | null;
  kind: Kind;
  reply: "required" | "none";
  ticket: string | null;
  summary: string;
  body: string;
  reply_to: string | null;
  thread_id: string;
  depth: number;
  forward_of: string | null;
  hash: string;
  state: MessageState;
  wake_state: WakeState;
  wake_id: string | null;
  read_at: number | null;
  acked_at: number | null;
  ack_note: string | null;
  superseded_by: string | null;
  not_before: number | null;
}

export interface WakeRow {
  id: string;
  at: number;
  recipient: string;
  app: App;
  method: string;
  message_ids: string;
  ok: number;
  detail: string;
  queue_item: string | null;
  followup: "delivered" | "opened" | "stuck" | null;
  followup_at: number | null;
}

const SCHEMA = `
create table if not exists messages (
  id text primary key,
  send_id text not null,
  created_at integer not null,
  sender text not null,
  sender_app text not null,
  sender_ref text not null,
  recipient text not null,
  recipient_app text not null,
  routed_from text,
  kind text not null,
  reply text not null,
  ticket text,
  summary text not null,
  body text not null,
  reply_to text,
  thread_id text not null,
  depth integer not null,
  forward_of text,
  hash text not null,
  state text not null,
  wake_state text not null,
  wake_id text,
  read_at integer,
  acked_at integer,
  ack_note text,
  superseded_by text
);
create index if not exists messages_recipient on messages(recipient, state, created_at);
create index if not exists messages_wake on messages(wake_state, recipient);
create index if not exists messages_sender on messages(sender, created_at);
create index if not exists messages_thread on messages(thread_id, created_at);
create table if not exists wakes (
  id text primary key,
  at integer not null,
  recipient text not null,
  app text not null,
  method text not null,
  message_ids text not null,
  ok integer not null,
  detail text not null
);
create index if not exists wakes_recipient on wakes(recipient, at);
create table if not exists leases (
  name text primary key,
  holder text not null,
  expires_at integer not null
);
create table if not exists servers (
  pid integer primary key,
  app text not null,
  ref text not null,
  address text,
  started_at integer not null,
  seen_at integer not null
);
create index if not exists servers_ref on servers(ref, seen_at);
create table if not exists codex_opens (
  thread text primary key,
  opened_at integer not null,
  stuck_at integer
);
create table if not exists telegram_messages (
  message_id integer primary key,
  mail_id text not null,
  sent_at integer not null
);
-- Global mail intake works even for already-loaded writers; never touches Codex's queue DB.
create table if not exists mail_operator (
  singleton integer primary key check(singleton=1), enabled integer not null,
  address text not null, app text not null, ref text not null
);
create table if not exists operator_routes (
  source_id text primary key, delivery_id text not null unique, recipient text not null,
  requested text not null, actual text not null, reason text not null, at integer not null, queue_status text not null default 'pending', queue_item text
);
create table if not exists mail_delivery_fence(singleton integer primary key, enabled integer not null);
create table if not exists mail_wake_claims(wake_id text primary key);
create table if not exists mail_delivery_exceptions(message_id text not null,wake_id text not null,reason text not null,primary key(message_id,wake_id));
create trigger if not exists operator_legacy_failure before update of wake_state on messages
when new.recipient_app='codex' and old.wake_state='woken' and new.wake_state='failed'
  and exists(select 1 from mail_delivery_fence where singleton=1 and enabled=1)
  and not exists(select 1 from mail_wake_claims where wake_id=old.wake_id)
begin
  insert or ignore into mail_delivery_exceptions values(old.id,coalesce(old.wake_id,''),'Legacy queue outcome unknown; reconcile before retry');
  update operator_routes set queue_status='unknown' where delivery_id=old.id;
  select raise(ignore);
end;

create trigger if not exists operator_claim_fence before update of wake_state on messages
when new.recipient_app='codex' and new.wake_state='woken' and coalesce(old.wake_state,'')!='woken'
  and exists(select 1 from mail_delivery_fence where singleton=1 and enabled=1)
  and not exists(select 1 from mail_wake_claims where wake_id=new.wake_id)
begin select raise(ignore); end;
create table if not exists operator_intakes(source_id text primary key,intended_recipient text not null,intended_app text not null,prior_routed_from text);
create table if not exists mail_coordinator_addresses(address text primary key);
create trigger if not exists operator_duplicate before insert on messages
when (new.recipient in (select address from mail_coordinator_addresses) or (new.sender_app='telegram' and new.forward_of is null))
  and exists(select 1 from mail_operator where singleton=1 and enabled=1 and new.sender != address)
  and not exists(select 1 from operator_routes where delivery_id=new.id)
  and exists(select 1 from messages m,mail_operator o where o.singleton=1 and m.recipient=o.address
    and m.sender=new.sender and m.sender_app=new.sender_app and m.hash=new.hash and m.created_at>new.created_at-86400000)
  and new.sender_app!='telegram'
begin
  select raise(abort,'Duplicate Operator intake; original retained');
end;
create trigger if not exists operator_intake after insert on messages
when (new.recipient in (select address from mail_coordinator_addresses) or (new.sender_app='telegram' and new.forward_of is null))
  and exists(select 1 from mail_operator where singleton=1 and enabled=1 and new.sender != address)
  and not exists(select 1 from operator_routes where delivery_id=new.id)
begin
  insert into operator_intakes values(new.id,new.recipient,new.recipient_app,new.routed_from);
  update messages set state='superseded',superseded_by=new.id,
    wake_state=case when wake_state in ('pending','failed','digest') then 'none' else wake_state end
    where recipient=(select address from mail_operator where singleton=1) and sender=new.sender
      and sender_app=new.sender_app and ticket=new.ticket and kind=new.kind and state='unread' and new.ticket is not null
      and id!=new.id and new.sender_app!='telegram';
  update messages set routed_from=coalesce(routed_from,recipient),
    recipient=(select address from mail_operator where singleton=1),
    recipient_app=(select app from mail_operator where singleton=1)
    where id=new.id;
end;
create unique index if not exists telegram_root_once on messages(sender_ref) where sender_app='telegram' and forward_of is null;
create table if not exists telegram_state (
  key text primary key,
  value text not null
);
create table if not exists events (
  seq integer primary key autoincrement,
  at integer not null,
  actor text not null,
  type text not null,
  ref text,
  detail text not null,
  prev text not null,
  hash text not null
);
create trigger if not exists telegram_offset_monotonic before update on telegram_state
when new.key='offset' and cast(new.value as integer)<cast(old.value as integer)
begin select raise(ignore); end;

`;

export function openStore(path: string, coordinators?: string[]): Database {
  if (path !== ":memory:") {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const db = new Database(path, { create: true });
  db.exec("pragma busy_timeout = 5000; pragma journal_mode = wal; pragma foreign_keys = on;");
  db.transaction(() => {
    db.exec(SCHEMA);
    migrate(db);
    if (coordinators !== undefined) configureCoordinators(db, coordinators);
  }).immediate();
  if (path !== ":memory:") {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Another process created it first; its mode stands.
    }
  }
  return db;
}

/** Routing projection only; the installation's JSON remains authoritative. No mail is changed. */
export function configureCoordinators(db: Database, addresses: string[]): void {
  db.transaction(() => {
    db.exec("delete from mail_coordinator_addresses");
    const insert = db.prepare("insert or ignore into mail_coordinator_addresses values (?)");
    for (const address of addresses) insert.run(address);
  }).immediate();
}

/** Additive column changes for stores created by earlier versions. */
function migrate(db: Database) {
  // Early/offline installations of this additive feature may already have its initial tables.
  const routeColumns = new Set(db.query<{name:string},[]>("pragma table_info(operator_routes)").all().map(c=>c.name));
  if(!routeColumns.has("queue_status")) db.exec("alter table operator_routes add column queue_status text not null default 'pending'");
  if(!routeColumns.has("queue_item")) db.exec("alter table operator_routes add column queue_item text");
  db.exec("create table if not exists mail_schema_versions(name text primary key,version integer not null)");
  const version=db.query<{version:number},[]>("select version from mail_schema_versions where name='operator'").get()?.version;
  if(version!==3) db.transaction(()=>{
    for(const name of ["operator_duplicate","operator_intake","operator_claim_fence","operator_legacy_failure","telegram_offset_monotonic"]) db.exec(`drop trigger if exists ${name}`);
    for(const trigger of SCHEMA.match(/create trigger if not exists (?:operator_\w+|telegram_offset_monotonic)[\s\S]*?end;/g) ?? []) db.exec(trigger);
    db.exec("insert into mail_schema_versions values('operator',3) on conflict(name) do update set version=3");
  }).immediate();
  if (!db.query("select 1 from mail_schema_versions where name='sideband_routing' and version=1").get()) db.transaction(() => {
    for (const name of ["operator_duplicate", "operator_intake"]) db.exec(`drop trigger if exists ${name}`);
    for (const trigger of SCHEMA.match(/create trigger if not exists (?:operator_duplicate|operator_intake)[\s\S]*?end;/g) ?? []) db.exec(trigger);
    configureCoordinators(db, []);
    db.exec("insert into mail_schema_versions values('sideband_routing',1) on conflict(name) do update set version=1");
  }).immediate();
  const wakeColumns = new Set(db.query<{ name: string }, []>("pragma table_info(wakes)").all().map((c) => c.name));
  // Codex follow-up: the queued item id, and whether the thread took it, was opened, or is stuck.
  if (!wakeColumns.has("queue_item")) db.exec("alter table wakes add column queue_item text");
  if (!wakeColumns.has("followup")) db.exec("alter table wakes add column followup text");
  if (!wakeColumns.has("followup_at")) db.exec("alter table wakes add column followup_at integer");
  const messageColumns = new Set(db.query<{ name: string }, []>("pragma table_info(messages)").all().map((c) => c.name));
  // A blocker or handoff sent over the rate limit is kept and woken no earlier than this.
  if (!messageColumns.has("not_before")) db.exec("alter table messages add column not_before integer");
}

export function newId(prefix = "m"): string {
  // 10 lowercase base32 characters: short enough to quote, ~50 bits of randomness.
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(10);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${prefix}_${out}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Appends to the hash-chained event log. Each row's hash covers the previous hash,
 * so editing or deleting history shows up in `sideband verify`.
 */
export function logEvent(db: Database, actor: string, type: string, ref: string | null, detail: unknown, at = Date.now()) {
  const append = db.transaction(() => {
    const last = db.query<{ hash: string }, []>("select hash from events order by seq desc limit 1").get();
    const prev = last?.hash ?? "genesis";
    const detailText = JSON.stringify(detail ?? {});
    const hash = sha256([prev, at, actor, type, ref ?? "", detailText].join("\u001f"));
    db.query("insert into events (at, actor, type, ref, detail, prev, hash) values (?, ?, ?, ?, ?, ?, ?)").run(
      at,
      actor,
      type,
      ref,
      detailText,
      prev,
      hash,
    );
  });
  append.immediate();
}

export function verifyChain(db: Database): { ok: boolean; checked: number; brokenAt?: number } {
  const rows = db
    .query<{ seq: number; at: number; actor: string; type: string; ref: string | null; detail: string; prev: string; hash: string }, []>(
      "select * from events order by seq asc",
    )
    .all();
  let prev = "genesis";
  for (const row of rows) {
    const hash = sha256([prev, row.at, row.actor, row.type, row.ref ?? "", row.detail].join("\u001f"));
    if (row.prev !== prev || row.hash !== hash) return { ok: false, checked: rows.length, brokenAt: row.seq };
    prev = row.hash;
  }
  return { ok: true, checked: rows.length };
}

/** A short exclusive lease, so only one process rings Codex threads at a time. */
export function takeLease(db: Database, name: string, holder: string, ttlMs: number, now = Date.now()): boolean {
  const take = db.transaction(() => {
    const row = db.query<{ holder: string; expires_at: number }, [string]>("select holder, expires_at from leases where name = ?").get(name);
    if (row && row.holder !== holder && row.expires_at > now) return false;
    db.query("insert into leases (name, holder, expires_at) values (?, ?, ?) on conflict(name) do update set holder = excluded.holder, expires_at = excluded.expires_at").run(
      name,
      holder,
      now + ttlMs,
    );
    return true;
  });
  return take.immediate();
}

/** Each chat's mail server checks in every few seconds, so the directory can say whose mail is live. */
export function heartbeat(db: Database, pid: number, app: App, ref: string, address: string | null, startedAt: number, now = Date.now()) {
  db.query(
    `insert into servers (pid, app, ref, address, started_at, seen_at) values (?, ?, ?, ?, ?, ?)
     on conflict(pid) do update set app = excluded.app, ref = excluded.ref, address = excluded.address, seen_at = excluded.seen_at`,
  ).run(pid, app, ref, address, startedAt, now);
}

export const HEARTBEAT_FRESH_MS = 30_000;

/** Refs (Claude session ids, Codex thread ids) whose mail server checked in recently. */
export function liveMailRefs(db: Database, now = Date.now()): Set<string> {
  return new Set(
    db
      .query<{ ref: string }, [number]>("select ref from servers where seen_at > ?")
      .all(now - HEARTBEAT_FRESH_MS)
      .map((r) => r.ref),
  );
}
