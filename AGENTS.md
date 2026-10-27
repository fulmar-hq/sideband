# Sideband contributor guide

Retain Bun/TypeScript, SQLite and local stdio MCP. This is a local command-line
product; no graphical styling or hosted service is implied.

Use isolated branches, signed product commits, meaningful temporary/inert tests,
type checking and independent maintainer review. Preserve message history,
idempotency, delivery leases and unknown-outcome/no-replay guards.

Keep secrets, personal data, runtime configuration, databases and backups out of
Git. Run the secret and privacy scans on the complete candidate and history.
Test fixtures must be clearly synthetic; narrowly justify any scanner exception.

Launch personas come from trusted client configuration, not tool arguments.
They are shared by chats using that registration and are not per-chat identity.
Client names are self-reported compatibility metadata, not authentication.
Do not claim native delivery or hosting from synthetic MCP checks.

Do not change repository visibility, publish packages/releases or post social
content without the project owner's explicit authorization. Source tests never
authorize real messages, account actions, client settings or service changes.
