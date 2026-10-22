# AGENTS.md — portato-vscode

Working rules for AI agents. The extension is a client of the Portato daemon;
the daemon, config and SSH logic live in the Go repo (`~/projects/pet/portato`)
and are never reimplemented here.

## Project state

Skeleton bootstrapped 2026-10-22; part 1 (MVP) of
`~/.opencode/plan/portato-vscode.md` is the next task.

## Contract source of truth

The Go repo: `internal/daemon/server.go` (endpoints), `internal/forward/state.go`
(status model), `internal/daemon/discovery.go` (socket path resolution),
`internal/log/ring.go` (log entry shape). When the daemon API changes, update
`src/types.ts` in the same PR.

## Stack

TypeScript strict · esbuild · VS Code Extension API · `vsce`.
`extensionKind: ["ui"]` — the daemon is local; under Remote-SSH / Dev
Containers the extension must run on the client machine.

## Commands

- `npm run compile` — esbuild bundle → `out/extension.js`
- `npm run watch` — watch mode for the Extension Development Host (F5)
- `npm run typecheck` — `tsc --noEmit`
- `npm run package` — `vsce package` (`.vsix`)

Part 1 adds: `npm test` — unit tests of the client against a fake HTTP server
on a temporary unix socket in Node (no real daemon), plus optional
`@vscode/test-electron` integration with a real `portato daemon` under
temporary `PORTATO_SOCKET` + `XDG_CONFIG_HOME`.

## Layout

```
src/
  extension.ts        activation (onView), command wiring
  types.ts            Status, State union, LogEntry — mirror of the Go contract
  discovery.ts        socket path: override → marker → runtime path; token path
  daemonClient.ts     HTTP over unix socket, token transport, 401 retry
  sse.ts              SSE parser for /events: signal frames, heartbeat, reconnect
  treeProvider.ts     TreeDataProvider: five states, actions
  prompts.ts          passphrase / password / host-key prompts
  daemonLifecycle.ts  detached `portato daemon` spawn, readiness via /healthz
```

## Daemon contract — key facts (verify against the Go repo, never guess)

- **State union (five strings):** `off | connecting | connected | reconnecting | error`.
- **Prompting** = state `connecting` + a non-empty pending flag:
  `pending_host`/`pending_fingerprint`/`pending_host_line` (TOFU),
  `pending_passphrase` (identity path), `pending_password`
  (`password:<user>@<host>:<port>`). Attempts counters:
  `passphrase_attempts`, `password_attempts`. Error text in `error`.
  `connected_at` is always present; `0001-01-01T00:00:00Z` means "never".
- **SSE `/events`:** signal-only `data: {}` frames → re-fetch `GET /tubers`;
  the first frame arrives immediately (it drives the initial load); heartbeat
  comment every 15 s (treat >45 s silence as dead); log changes do NOT
  produce events. `EventSource` does not work over a unix socket — the parser
  is hand-rolled.
- **Token:** `portato.token` in `dirname(socketPath)`, regenerated on every
  daemon start. Re-read on every (re)connect; on 401 re-read once and retry;
  no file → send no header.
- **Discovery:** `PORTATO_SOCKET` → JSON marker `{"socket","pid"}` at
  `$XDG_CONFIG_HOME/portato/daemon.socket` (socket counts only if `/healthz`
  answers) → runtime path (macOS `~/Library/Application Support/portato/portato-<uid>.sock`).
  env-dependent: a GUI-launched VS Code may not see shell exports — the
  `portato.socketPath` override exists for that.
- **`PUT /tubers/{name}` replaces the tuber wholesale** — the edit form must
  round-trip every field of the config Tuber or data is silently lost.
  `move` takes `?delta=±N` in the query, no body; out-of-range is a 200 no-op.
- **Tunnel names in URLs** go through `encodeURIComponent`.
- **Errors:** body `{"error":"…"}`; codes 400/401/404 (unknown tuber)/409
  (nothing pending / duplicate)/500. A second daemon is blocked by flock with
  "daemon already running". `enable`/`disable` persist `enabled` in the
  config; `restart` does not.

## Operating rules

- Never log tokens, passphrases, passwords, or `GET /config` bodies (the
  config carries `socks5_password` in plain text). Never pass secrets through
  argv.
- All I/O is async; no `*Sync` fs/child_process calls; lazy activation.
- `portato daemon` is a foreground process: spawn `{ detached: true,
  stdio: "ignore" }` + `unref()`; wait for readiness via `/healthz`, not by
  watching for the socket file (it appears before the token is written).
- Prompts are offered via a notification action, never an unsolicited input
  box; dedupe by (tuber, pending kind, attempts); attempts > 0 shows a
  "wrong passphrase/password" hint; host-key accept is a modal with host +
  fingerprint.
- Tolerate daemon absence: a "not running" state + a Start button. A
  standalone-mode TUI holds the ports busy — surface a clear error.
- SSE reconnect uses backoff and re-runs discovery + token read.

## Repo rules

- Conventional Commits (`feat(<scope>): …`, `fix(…)`, `chore(…)`); non-trivial
  commits carry a body saying what and why.
- English in the repo; UI strings via `vscode.l10n` / `package.nls.json`.
- No commits or pushes without explicit permission.
- Task plan: `~/.opencode/plan/portato-vscode.md`.
