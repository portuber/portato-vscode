# AGENTS.md -- portato-vscode

Working rules for AI agents. The extension is a client of the Portato daemon;
the daemon, config and SSH logic live in the Go repo (`~/projects/pet/portato`)
and are never reimplemented here.

## Project state

Parts 1 and 2 are implemented and reviewed. Part 1: socket discovery, daemon
client, SSE, tunnels tree, prompts, daemon lifecycle, controller wiring, unit
tests plus an integration suite against a disposable real daemon
(`PORTATO_BINARY` / `/opt/homebrew/bin/portato`). Part 2: logs output channel
(lazy poll with adaptive backoff -- a channel never opened is never fetched,
and new entries append under the filter instead of re-rendering;
tail-anchored dedup), tunnel CRUD via a webview form with conflict
check, identity passphrase store/forget, drag-and-drop reorder (the daemon's
move swaps, so inserts are chains of +/-1), tag grouping + filter, manual
config Reload (the daemon watches its own config), and l10n -- every UI
string goes through `vscode.l10n.t` / `package.nls.json` (parity is pinned
by `src/test/nls.test.ts`; pure modules take an injected translator with an
identity default, see `renderBar` / `validateFields`).
The extension is unix-only (macOS/Linux); the daemon's Windows named pipe is
not implemented (README "Platform support").

## Contract source of truth

The Go repo: `internal/daemon/server.go` (endpoints), `internal/forward/state.go`
(status model), `internal/daemon/discovery.go` (socket path resolution),
`internal/log/ring.go` (log entry shape). When the daemon API changes, update
`src/types.ts` in the same PR.

## Sibling repo (read-only, no prompt)

`../portato` -- the Portato Go repo (the daemon this extension talks to).
Reading it is allowed without a prompt where a local
`.opencode/opencode.json` exists (gitignored; copy
`.opencode/opencode.jsonc.example` and adjust the paths); edits to Go code
happen only in that repo's own session and only on explicit request. When
the daemon IPC contract changes, update this file's contract section and
`src/types.ts` together.

## Stack

TypeScript strict, esbuild, VS Code Extension API, `vsce`.
`extensionKind: ["ui"]` -- the daemon is local; under Remote-SSH / Dev
Containers the extension must run on the client machine.

## Commands

- `npm run compile` -- esbuild bundle -> `out/extension.js`
- `npm run watch` -- watch mode for the Extension Development Host (F5)
- `npm run typecheck` -- `tsc --noEmit`
- `npm run package` -- `vsce package` (`.vsix`)

Part 1 adds tests run by plain `node --test` over esbuild bundles (no VS
Code): `npm test` -- unit tests of the client against a fake HTTP server on a
temporary unix socket in Node (no real daemon, hermetic for CI);
`npm run test:integration` -- suite against a real `portato daemon` under
temporary `--socket` + `XDG_CONFIG_HOME`/`XDG_STATE_HOME` (binary from
`$PORTATO_BINARY` or `/opt/homebrew/bin/portato`; skips when absent);
`npm run test:all` -- both.

Releases: `make release-patch|minor|major` (or `make release VERSION=vX.Y.Z`)
gates on a clean tree + a CHANGELOG.md section, runs typecheck + unit tests,
bumps package.json and package-lock.json, commits, tags and pushes; the tag triggers
`.github/workflows/release.yml` (package, version guard, GitHub Release with
vsix + checksums, Marketplace publish via the VSCE_PAT secret).

## Layout

```
src/
  extension.ts        activation (onView), command wiring
  types.ts            Status, State union, LogEntry -- mirror of the Go contract
  discovery.ts        socket path: override -> marker -> runtime path; token path
  daemonClient.ts     HTTP over unix socket, token transport, 401 retry
  rawHttp.ts          raw HTTP/1.1 over net sockets: VS Code patches node:http
                      in the extension host (proxy agent) and breaks unix
                      sockets -- never use node:http for daemon calls
  sse.ts              SSE parser for /events: signal frames, heartbeat, reconnect
  statusBar.ts        pure status-bar rendering + context-key send decisions
  logDedup.ts         LogTail ring diff (tail-anchored), applyPoll buffer math (pure)
  logsPoll.ts         poll gating + adaptive backoff delays (pure)
  logsView.ts         "Portato Logs" output channel: poll /logs, filter, min level
  identityPaths.ts    identity-passphrase candidate paths for a tunnel (pure)
  treeProvider.ts     TreeDataProvider: five states, tag grouping, filter, DnD reorder
  treeGroups.ts       pure grouping/filter visibility/move-delta math
  tuberFormFields.ts  pure add/edit form: prefill, tag parsing, body merge, deep-compare
  tuberForm.ts        add/edit tunnel webview form (conflict check, no secrets inline)
  prompts.ts          passphrase / password / host-key prompts
  daemonLifecycle.ts  detached `portato daemon` spawn, readiness via /healthz
```

## Daemon contract -- key facts (verify against the Go repo, never guess)

- **State union (five strings):** `off | connecting | connected | reconnecting | error`.
- **Prompting:** host key = non-empty `pending_host` regardless of state (the
  daemon keeps it through `error`/`reconnecting` between redials; the TUI
  checks `PendingHost != ""`). Passphrase/password = state `connecting` plus
  `pending_passphrase` / `pending_password` (the dial blocks there; on dial
  failure the daemon clears them before `setStateErr`). Attempts counters:
  `passphrase_attempts`, `password_attempts`; a dismissed prompt never
  re-asks by itself (attempts don't bump while blocked) -- offer a tree
  action that re-opens it. Error text in `error`.
  `connected_at` is always present; `0001-01-01T00:00:00Z` means "never".
- **SSE `/events`:** signal-only `data: {}` frames -> re-fetch `GET /tubers`;
  the first frame arrives immediately (it drives the initial load); heartbeat
  comment every 15 s (treat >45 s silence as dead); log changes do NOT
  produce events. `EventSource` does not work over a unix socket -- the parser
  is hand-rolled.
- **Token:** `portato.token` in `dirname(socketPath)`, regenerated on every
  daemon start. Re-read on every (re)connect; on 401 re-read once and retry;
  no file -> send no header.
- **Discovery:** `portato.socketPath` setting -> env `PORTATO_SOCKET` -> JSON
  marker `{"socket","pid"}` (pid must be > 0) at
  `<ConfigHome>/portato/daemon.socket`, where ConfigHome = `$XDG_CONFIG_HOME`
  or the platform default (macOS `~/Library/Application Support`, Linux
  `~/.config`) -- the marker socket counts only if `/healthz` answers -> runtime
  path (macOS `<StateHome>/portato/portato-<uid>.sock`, Linux
  `$XDG_RUNTIME_DIR` or `/run/user/<uid>`). env-dependent: a GUI-launched
  VS Code may not see shell exports -- the `portato.socketPath` override
  exists for that.
- **`GET /healthz` -> `{"ok":true}`; since daemon v1.11.0 also `version`.**
- **`PUT /tubers/{name}` replaces the tuber wholesale** -- the edit form must
  round-trip every field of the config Tuber or data is silently lost.
  `move` takes `?delta=+-N` in the query, no body, and **swaps** with the
  element at idx+delta (it does not insert); out-of-range is a 200 no-op.
  The extension emulates insert with |delta| sequential +/-1 moves.
- **GET /config** returns the live config (`defaults` carries
  `socks5_password` in plain text -- never log it). `password_auth` is
  `*bool`: absent = inherit (on), explicit false = opt out. The daemon's
  own file watcher (500 ms poll + 300 ms settle) reloads config.yaml after
  manual edits, so the extension needs no filewatcher.
- **POST /identities {path,passphrase} / DELETE /identities?path=** manage
  the passphrase cache keyed by the EXACT path string (send absolute paths,
  `~` expanded); a host without a keyring backend answers 500.
- **Tunnel names in URLs** go through `encodeURIComponent`.
- **Errors:** body `{"error":"..."}`; codes 400/401/404 (unknown tuber)/409
  (nothing pending / duplicate)/500. A second daemon is blocked by flock with
  "daemon already running". `enable`/`disable` persist `enabled` in the
  config; `restart` does not.

## Operating rules

- Never log tokens, passphrases, passwords, or `GET /config` bodies (the
  config carries `socks5_password` in plain text). Never pass secrets through
  argv.
- All I/O is async; no `*Sync` fs/child_process calls; lazy activation.
- `portato daemon` is a foreground process: spawn
  `{ detached: true, stdio: ["ignore","ignore",<log fd>] }` + `unref()`.
  stderr goes to `<ConfigHome>/portato/daemon-launch.log` (read its tail on
  failure) -- a pipe owned by the extension host would SIGPIPE-kill the Go
  daemon after host exit; wait for readiness via `/healthz`, not by watching
  for the socket file (it appears before the token is written).
- Prompts are offered via a notification action, never an unsolicited input
  box; dedupe by (tuber, pending kind, attempts); attempts > 0 shows a
  "wrong passphrase/password" hint; host-key accept is a modal with host +
  fingerprint. An empty secret is legitimate but must be a confirmed choice:
  the toast carries one action ("Enter passphrase/password"), the input box
  accepts an empty answer, and a modal confirms sending it (Cancel re-opens
  the box). `answerPrompt` for a tuber in `connecting` whose host key was
  just accepted says "handshake in progress" instead of "no prompt is
  pending" (shared `pendingHosts` map, pure `promptForPlan`).
- Tolerate daemon absence: a "not running" state + a Start button. A
  standalone-mode TUI holds the ports busy -- surface a clear error.
- SSE reconnect uses backoff and re-runs discovery + token read.

## Repo rules

- Conventional Commits (`feat(<scope>): ...`, `fix(...)`, `chore(...)`); non-trivial
  commits carry a body saying what and why.
- English in the repo; UI strings via `vscode.l10n` / `package.nls.json`.
  Runtime strings are extraction-ready literals inside `t(...)` calls (no
  key indirection: the bundle extractor only sees literals); the `l10n/`
  bundle directory and the package.json `"l10n"` field land together with
  the first actual translation.
- No commits or pushes without explicit permission.
- Task plan: `~/.opencode/plan/portato-vscode.md`.
