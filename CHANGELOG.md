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

[0.1.0]: https://github.com/portuber/portato-vscode/releases/tag/v0.1.0
[0.1.1]: https://github.com/portuber/portato-vscode/releases/tag/v0.1.1
