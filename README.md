# Sideband

A small, self-hosted mailroom for Claude Code and Codex. Give your coding
assistants named inboxes for handoffs, questions and blockers instead of copying
messages between windows. Messages, read/ack status and delivery receipts stay in
one local SQLite database. MIT licensed.

Sideband runs as a local stdio MCP server. No hosted account, network listener or
model API is needed to install it. Your coding clients use their own accounts.

## Five-minute local setup

Prerequisites: macOS or Linux, Git, Bun1.3.14 or later, and installed Claude Code
and Codex clients. Windows installation is not supported yet.

### 1. Install and create a project

```sh
git clone https://github.com/fulmar-hq/sideband.git
cd sideband
bun run setup -- --name "My project" --config "$HOME/.config/sideband/my-project.json" --starter-pair
```

One setup command installs locked production dependencies, a versioned runtime,
launcher and private config. It prints the actual paths and client settings.
It does not start services, send messages, edit client settings or overwrite an
existing config. Pick a new config filename for each project. Each file gets its
own default `state/<config-filename>/mail.sqlite` store beside the config.
Renaming/moving a config changes that default location; use explicit `paths.db`
when you need a stable existing store.

The starter pair is **Planner** for Claude Code and **Engineer** for Codex.
These are examples, not accounts or verified individual chat identities. See
[the example config](examples/sideband.example.json) to change names/roles.

### 2. Connect Claude Code

From the code project where you want to use Sideband, run the printed command.
With the default install location:

```sh
claude mcp add --scope local --env SIDEBAND_AGENT=Planner --transport stdio sideband -- "$HOME/.local/share/sideband/bin/sideband" serve --config "$HOME/.config/sideband/my-project.json"
```

Use Claude Code's normal MCP connection/approval controls. Registration alone is
not proof that the running client loaded a server. [Official MCP setup](https://code.claude.com/docs/en/mcp).

### 3. Connect Codex

In your trusted code project's `.codex/config.toml`, add the block printed by
setup. Use its **actual absolute paths**, not the placeholder paths below:

```toml
[mcp_servers.sideband]
command = "/absolute/install/path/bin/sideband"
args = ["serve", "--config", "/absolute/config/path/my-project.json"]
env = { SIDEBAND_AGENT = "Engineer" }
```

Start/connect Codex normally and inspect its MCP tools. [Official MCP configuration](https://developers.openai.com/codex/mcp).

### 4. Try a handoff

Ask each client to call Sideband `agents`. Claude should report Planner and
Codex Engineer. Then explicitly ask Planner to send Engineer a harmless example
handoff. Ask Engineer to read its inbox and acknowledge that message.

**Basic setup uses manual inbox reads.** Sideband does not claim that installing
an MCP server wakes an idle model. Optional native bindings/wake adapters depend
on host metadata and client versions; they are not part of this quickstart.

## Personas and trust

`SIDEBAND_AGENT` is an administrator-chosen launch persona. **Every chat using
that same client registration shares its inbox and sender identity.** Use a
separate configured registration/process for another persona. This is not
per-chat authentication. A reported client name is a compatibility check, not an
authentication mechanism.

Tools cannot choose a `from` address. Missing/unregistered personas and mismatched
client types refuse sending. Keep the configuration and launcher trusted/private.
Other processes running as the same local user can edit those files or the store;
Sideband is not a sandbox or a multi-user authorization service.

Mail is information, not human approval. Project permission rules still apply.
A stored/queued message, recipient read and completed task are different facts.

## Tools and diagnostics

- `agents`: configured personas and connection/native status.
- `send`, `forward`: structured messages, preserving actual sender/text.
- `inbox`, `read`, `ack`, `outbox`: current unread mail and honest receipts.
- Optional Operator routing tools require the configured Operator persona.

```sh
~/.local/share/sideband/bin/sideband doctor --config "$HOME/.config/sideband/my-project.json"
~/.local/share/sideband/bin/sideband peek Engineer --config "$HOME/.config/sideband/my-project.json"
```

Doctor validates config; it does not test native delivery or open the mail store.
Peek reads stored mail without marking it read. Configuration details, optional
Telegram and native adapters: [configuration](docs/configuration.md).

## Upgrade and remove

Install a reviewed newer source version with the same root/config arguments.
Versions are immutable; existing config/mail and the previous runtime are kept.
A failed dependency install leaves the previous version selected. Unknown roots,
altered versions or a concurrent install lock refuse instead of overwriting data.

Before rollback, confirm old code understands the current config/store; never
remove mail or unknown-delivery metadata to make it start. Remove client
registrations before deleting the owned install directory. Config/mail remain
separate unless you explicitly delete them.

## Self-hosting and support

Run Sideband on the machine where the coding clients run. The current transport
is local stdio; this is not a remote HTTP or multi-tenant SaaS server. Deployment
or hosting assistance can be arranged with the maintainer; no managed hosting
service or SLA is promised by this release.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
```

Tests use temporary stores and synthetic transports/processes, not real accounts.
CI also runs Gitleaks and a bounded privacy scan across the complete Git history.
See [security](SECURITY.md), [contributing](CONTRIBUTING.md) and [license](LICENSE).
