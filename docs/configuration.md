# Configuration

One trusted JSON file configures a project. `SIDEBAND_CONFIG` or CLI `--config`
selects it; otherwise the standard user config directory is used. Invalid or
ambiguous explicit configuration refuses startup. Relative paths are resolved
beside the file. The default store is `state/<config-filename>/mail.sqlite`, so
different files in one directory have separate inboxes. Moving/renaming a config
changes that default; set explicit `paths.db` to retain a stable store. An explicit
shared database remains shared by choice, not a security boundary.

Required: version1, name, authority, agents, coordinators and ticket prefixes.
See the starter example. Roles are builder, coordinator, expert and relay.
Aliases are one-hop recipient names pointing to a declared address, never a
sender mapping. Coordinator routes use canonical declared coordinator roles.

## Launch personas

Use `binding: "launch"` and a trusted client launch environment
`SIDEBAND_AGENT=<declared address>`. Every chat using that registration shares
the persona. ClientInfo names are self-reported compatibility metadata; this is
not per-chat or remote-user authentication. Sender cannot come from tool args.
A missing identity can inspect the directory but cannot read/send private mail.

Connection status means the MCP process checked in, not that a model is idle.
Basic launch personas use manual inbox retrieval; native delivery is not inferred.

## Optional native bindings

An advanced Claude binding can supply a base `title` instead of launch mode;
a Codex binding can supply a native `threadId`. These require compatible
host-provided session/thread metadata and configured local app paths. They do not
make a self-reported client name an authentication credential. Native discovery,
queueing and wake behavior are version-sensitive; verify them on the target host.
Do not reuse a real identity/recipient as a synthetic test.

## Optional fields

- `aliases`: literal recipient alias to an existing canonical agent.
- `operator`: declared Codex routing persona; activation remains explicit.
- `human` and `telegram: { "envFile": "telegram.env" }`: optional human transport.
  Keep credentials outside Git/config. Chat AND sender IDs must match before a
  human reply is accepted. No group-chat or arbitrary-sender approval is inferred.
- `timeZone`, `digestTimes`: message/digest display settings.
- `coordinatorDigestMinutes`: default0; optional routine-message scheduling.
- `paths`: db, claudeLiveDir, claudeDesktopDir, codexStateDb, codexQueueDb, codexBin.

New config/store files are private. Config loads at process startup; reconnect
clients after changing registrations or process settings. Setup never changes
client approvals. Unknown delivery outcomes are retained for reconciliation,
not blindly replayed. The event log has a hash chain for tamper detection, not
protection against another process with the same local-user access.
