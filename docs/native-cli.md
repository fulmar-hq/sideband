# Native CLI fallback

`sideband agents --json --config /path/to/project.json` returns the same directory
as the ordinary text command, as a JSON array. It does not prove that a chat is
safely idle or that a message was delivered.

`sideband send '<message-json>' --config /path/to/project.json` is a fallback for
an already configured **native Codex host**, using the host's current thread
context. It uses the same message validation, recipient rules, secret checks
and duplicate fence as the MCP send tool. The JSON message has `to`, `kind`,
`reply`, `summary` and the ordinary optional message fields. A receipt means
stored/queued, not read or completed.

The sender comes from the configured native thread. There is no caller-address
argument. Missing or unregistered native context is refused before opening the
mail store; a shared launch persona is not a fallback identity. Malformed JSON
and typed sender fields are refused. A repeated identical message is refused by
the existing duplicate fence; it is not silently sent again.

The starter-pair quickstart uses shared launch personas through MCP. Installing
it does not establish native thread bindings or enable native CLI sending.
Other local processes with the same account can change configuration or process
environment: this is the existing local trust boundary, not multi-user or
cryptographic authentication.

This CLI leaf does not add native open/ring/follow-up commands or positive-idle
verification. Unsupported directory flags fail explicitly. It does not install
a new receiver, change registry ownership, migrate a live database, prove loaded
client compatibility or authorize any Telegram message or account change.
Telegram chat administration is a separate feature; its actual command/export
must be integrated and reviewed before it is offered here.
