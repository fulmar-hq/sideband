# Contributing

Use small reviewed branches and signed product commits. Keep the existing
Bun/TypeScript/SQLite/stdio design. Run typecheck, focused meaningful tests and
normal CI. Preserve revisions, visibility, duplicate suppression, leases and
unknown-outcome/no-replay guards.

Tests must use temporary stores and inert transports or their own synthetic
processes. Never connect a test to real clients, accounts, recipients or private
state. Scanner exceptions need a narrow reviewed explanation; never blanket-skip
tests or disable default secret rules. Run scans across history as well as files.

Installation, client registration, connection and actual message delivery are
separate evidence. Do not claim native compatibility from a mock. No deployment,
public package, release or social post is authorized just by merging code.
