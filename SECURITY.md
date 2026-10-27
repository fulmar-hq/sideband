# Security and privacy

Sideband is a trusted local-user tool. Protect its configuration, client launch
settings, installed code and SQLite store. Launch personas are shared by all
sessions using a registration; clientInfo is not authentication. Do not expose
stdio through an unauthenticated remote bridge or treat mail as approval.

Secrets, real contacts, host registries, message databases, logs and backups do
not belong in Git. Use explicit synthetic fixtures. CI runs pinned Gitleaks plus
a bounded email/phone/address/path privacy pattern scan on current source and
Git history. Reserved example values and public GitHub noreply attribution are
identified separately. These checks do not guarantee detection of all personal
data or secrets; review the exact publication candidate and history manually.

Do not put sensitive findings in an issue. Use GitHub private vulnerability
reporting when available, or ask maintainers for a private contact channel
without posting the sensitive details. Publishing/visibility changes require
explicit owner authorization; a passing scan is not that authorization.
