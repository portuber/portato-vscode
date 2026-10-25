# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-24

First public release.

### Added

- Tunnels tree in the activity-bar view with live status for all five tunnel
  states (`off`, `connecting`, `connected`, `reconnecting`, `error`), updated
  over SSE with reconnect and heartbeat watchdog.
- Tunnel actions: enable / disable / restart from the tree.
- Tunnel management: add / edit / delete via a webview form that round-trips
  every config field, with a name-conflict check; drag-and-drop reordering;
  grouping by tags and a text filter.
- Prompt handling: passphrase and password prompts as notification actions
  (with a wrong-secret hint and confirmed empty-secret submit), TOFU host-key
  acceptance modal with fingerprint.
- Identity passphrase store / forget per tunnel key.
- Logs: a single "Portato Logs" output channel, daemon-wide or filtered to
  one tunnel, with a minimum-level filter; lazy polling with adaptive
  backoff and tail-anchored dedup.
- Daemon lifecycle: start the daemon from the view (readiness via `/healthz`),
  stop it, and survive a daemon restart mid-session (the view falls back to a
  "not running" state with a Start button).
- Error handling: distinct UX for a daemon that rejects the extension's IPC
  token, stale tree items after out-of-band config edits (auto-refresh), and
  contextual messages for 404/409 responses.
- Raw-socket HTTP transport to the daemon: `node:http` is unusable for unix
  sockets in the extension host (VS Code's proxy agent patches `http.request`
  under the default `http.proxySupport`), so the client speaks minimal
  HTTP/1.1 over raw `net` sockets, with chunked decoding for streamed
  responses (SSE).
- Distinct view-title icons for the log-level filter (list-filter glyph) and
  clearing the tunnel filter (close glyph).
- Manual config reload action (the daemon watches its own config, the action
  covers out-of-band watchers).
- Localization-ready UI strings (`vscode.l10n` + `package.nls.json`).
- CI: typecheck, compile, unit tests and `vsce package` on GitHub Actions.

## [0.1.1] - 2026-10-25

Maintenance release: no user-facing extension changes.

### Fixed

- CI reliability: a fake-daemon token-rotation test no longer races the
  401-retry on slow runners (test-only).

### Added

- Automated releases: `make release-{patch,minor,major}` targets and a
  tag-triggered release workflow (development tooling).

## [0.1.2] - 2026-10-25

Hotfix release for verified bugs found in external review.

### Fixed

- A daemon whose IPC token file is unreadable (e.g. `EACCES`) was probed as
  "not running" because the probe treated its 401 as a dead socket; the view
  offered a Start button whose spawn only lost the daemon's single-instance
  flock. Any HTTP answer now counts as alive: the start path reuses the
  socket, and the UI shows the existing credentials-rejected state.
- Truncated HTTP bodies resolved as success: a clean close without the
  promised `Content-Length` bytes no longer passes as a response, and a 2xx
  body that is not valid JSON fails loudly instead of wiping the tunnels
  tree to "no tunnels".
- Host-key accept race: the TOFU modal's (host, fingerprint) pair is
  re-checked against a fresh status right before the accept POST; if the
  pending key changed while the modal was open, nothing is sent and the new
  key raises its own notification. (A small window remains until the daemon
  API accepts an expected fingerprint -- tracked as a portato follow-up.)
- Disposing the controller mid-connect no longer restarts the SSE loop and
  log polling after teardown, and no longer adopts a late daemon client
  that nothing would destroy.
- After Start Daemon / Refresh, the SSE stream now reconnects immediately
  instead of serving out its reconnect backoff (up to 30 s).
- A stale concurrent `/tubers` fetch can no longer regress the tree with
  older statuses.
- The edit form no longer shows the SOCKS5 replace/clear UI for tunnels
  without a stored password (absent `socks5_password` key was read as
  "set"), and a 409 duplicate-name error from Add shows a localized
  message instead of the daemon's raw text.
- Tree rows show localized state labels (previously raw enum values);
  the identity quick-pick note is localization-ready.

### Changed

- **Breaking (settings scope):** `portato.binaryPath` and
  `portato.socketPath` are now machine-scoped, and the extension declares
  it does not support untrusted workspaces. A workspace can no longer
  redirect which binary runs or which socket receives the secrets you type.
  If you set either per workspace, move the value to user settings.
- Requires VS Code 1.90+ (Node 20 extension host, matching the build
  target; previously advertised 1.85 while shipping Node 20 syntax).
- The demo animation is no longer packaged into the `.vsix` (it stays in
  the repository README).

## [0.2.0] - 2026-10-25

UX and onboarding release: welcome views, a status-bar quick pick, tree
context actions, new settings, and mitigations for known daemon bugs.

### Added

- Welcome views in the Tunnels panel: a missing `portato` binary, a stopped
  daemon, a daemon that rejects the extension's IPC token, and an empty
  tunnel list each render actionable guidance instead of a bare tree. A
  brief loading state keeps "not running" from flashing during discovery.
- The status bar item is now clickable: a quick pick offers daemon actions
  (start/stop/restart, show logs, add tunnel) plus one row per tunnel with
  its state; picking a tunnel toggles it, and a tunnel blocked on a prompt
  opens that prompt instead. The bar shows an attention tally (tunnels in
  `error` plus pending prompts) with a warning background.
- Tree context actions: Copy Local Address (wildcard binds normalized to
  the loopback), Open in Browser (local forwards), and Copy SOCKS URL
  (dynamic tunnels; the username follows the daemon's resolution rule --
  the tunnel's own `socks5_user` when set, else the config default -- and
  is percent-encoded; the password is never embedded).
- Tag-group context menu: Show Only This Tag filters the tree; New Tunnel
  with This Tag preseeds the add form.
- New settings: `portato.minLogLevel` (default level for the daemon log
  view), `portato.autoStartDaemon` (machine scope, default off; starts the
  daemon when the view opens and none is running -- at most once per
  window, never after you stop the daemon yourself, only when the binary
  resolves) and `portato.showNotifications` (informational toasts only;
  warnings, errors and prompts are always shown).
- The daemon's version from `/healthz` is checked against a minimum
  (1.11.0) and surfaced as a one-time warning when missing, unrecognized
  or older; nothing is ever blocked by it.
- A lazy `Portato Diagnostics` log channel for the extension's own
  diagnostics (version warnings, auto-start decisions, IPC errors). The
  daemon log stream keeps its own `Portato Logs` channel with unchanged
  timestamps.

### Fixed

- Daemon bug D2 mitigation: saving an edit that flips `enabled` now
  follows the PUT with an explicit enable/disable call under the saved
  name, so the flip applies immediately instead of after a daemon restart.
  A failed follow-up after a saved PUT is reported as a warning ("tunnel
  saved, but the enable/disable follow-up failed: ...") instead of
  passing as a plain success.
- Daemon bug D5 mitigation: Stop tears the SSE stream and client down
  before the CLI stop; a failed stop re-arms discovery so a still-running
  daemon is quietly re-adopted instead of leaving a dead view.
- Informational toasts (copy confirmations, filter results) obey
  `portato.showNotifications` instead of always firing.

[0.1.0]: https://github.com/portuber/portato-vscode/releases/tag/v0.1.0
[0.1.1]: https://github.com/portuber/portato-vscode/releases/tag/v0.1.1
[0.1.2]: https://github.com/portuber/portato-vscode/releases/tag/v0.1.2
[0.2.0]: https://github.com/portuber/portato-vscode/releases/tag/v0.2.0
