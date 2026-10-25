# Portato for VS Code

A VS Code extension -- a client for the [Portato](https://github.com/portuber/portato)
daemon: manage SSH port-forwarding tunnels from the sidebar.

![demo](media/demo.gif)

The extension is only a client: the daemon, the config and all SSH logic
live in the `portato` binary. It discovers a running daemon on its own
(marker file or runtime socket) and keeps the tree in sync over SSE; when
no daemon is running, the view offers a Start button that launches one
(it never spawns a daemon on its own).

## Features

- **Tunnels tree** with live status for all five tunnel states (off,
  connecting, connected, reconnecting, error) -- updates arrive over SSE,
  no manual refresh needed.
- **Tunnel actions**: enable / disable / restart, plus add / edit / delete
  in a form that round-trips every config field (with a name-conflict
  check) and drag-and-drop reordering.
- **Tags**: group tunnels by tag, filter by text.
- **Prompts**: passphrase and password prompts pop up as notifications
  (empty secrets need an explicit confirmation); unknown host keys open a
  TOFU modal with the fingerprint.
- **Identities**: store / forget the passphrase of a tunnel's identity key.
- **Logs**: a single "Portato Logs" output channel, daemon-wide or filtered
  to one tunnel, with a minimum-level filter.
- **Daemon lifecycle**: start / stop the daemon from the view; if the daemon
  dies mid-session the view degrades to a "not running" state with a Start
  button and picks it back up automatically.
- **SSH config import**: a dry-run preview of the forwards in
  `~/.ssh/config`, picked per host and written to the portato config.
- **Doctor**: the CLI doctor's health report in a terminal, plus one-click
  access to the portato config file.

A short walkthrough opens on first install (Welcome page -> Get started
with Portato).

## Commands

Everything is reachable from the Portato view; the palette commands are a
convenience subset.

| Command | Palette | Where |
| --- | --- | --- |
| Portato: Refresh | yes | view title |
| Portato: Start Daemon | yes | view title + stopped welcome view |
| Portato: Stop Daemon | yes | view title |
| Portato: Show Logs | yes | view title |
| Portato: Set Log Level... | yes | view title |
| Portato: Filter Tunnels... | yes | view title |
| Portato: Clear Tunnel Filter | no | view title (while a filter is active) |
| Portato: Add Tunnel | yes | view title + welcome views |
| Portato: Reload Config | yes | view title |
| Portato: Tunnels and Daemon... | yes | status bar item |
| Portato: Import Forwards from SSH Config | yes | palette |
| Portato: Run Portato Doctor / Run Portato Doctor (Probe Servers) | yes | palette |
| Portato: Open Portato Config | yes | palette |
| Portato: Open the Portato Website | yes | palette + welcome views |
| Portato: Enable Tunnel / Disable Tunnel / Restart Tunnel | no | tunnel inline actions |
| Portato: Answer Prompt | no | tunnel inline action |
| Portato: Edit Tunnel / Delete Tunnel | no | tunnel context menu |
| Portato: Show Tunnel Logs | no | tunnel context menu |
| Portato: Store Identity Passphrase / Forget Identity Passphrase | no | tunnel context menu |
| Portato: Copy Local Address / Open in Browser / Copy SOCKS URL | no | tunnel context menu |
| Portato: Show Only This Tag / New Tunnel with This Tag | no | tag-group context menu |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `portato.binaryPath` | `portato` | Path to the `portato` binary used to start the daemon. Set it when VS Code cannot find `portato` on its PATH (common for GUI-launched VS Code on macOS). Machine scope: set it in user settings, not per workspace. |
| `portato.socketPath` | `portato` default discovery | Explicit daemon socket path. Overrides discovery; use it if your shell exports `PORTATO_SOCKET` that a GUI-launched VS Code cannot see, or to point at a non-default daemon. Machine scope: set it in user settings, not per workspace. |
| `portato.groupByTag` | `false` | Group tunnels by their first tag in the tree. |
| `portato.minLogLevel` | `info` | Minimum level shown in the `Portato Logs` view. The **Portato: Set Log Level...** command overrides it for the current session. |
| `portato.autoStartDaemon` | `false` | Start the daemon automatically when the Tunnels view opens and none is running. At most once per window, never after you stop the daemon yourself, and only when the `portato` binary resolves. Machine scope. |
| `portato.showNotifications` | `true` | Informational notifications only (copy confirmations, filter results). Warnings, errors and passphrase/host-key prompts are always shown. |

## Requirements

- VS Code 1.90 or newer (the bundled extension host runs Node 20, matching
  the extension's build target).
- The [portato](https://github.com/portuber/portato) CLI installed and on
  PATH (or pointed to by `portato.binaryPath`). When no daemon is running,
  start it from the Portato view; an externally started daemon is picked
  up too.

## Platform support

macOS and Linux only. The daemon's Windows build serves a named pipe
(`\\.\pipe\portato`, see `internal/daemon/paths_windows.go`) and this
extension does not implement that transport yet; on Windows it degrades to
"daemon not running". Full Windows support is a planned, separately tested
task.

## Remote workspaces (Remote-SSH, WSL, Dev Containers)

The extension is `extensionKind: ui`: under Remote-SSH, WSL or Dev
Containers it installs on the local machine, next to the portato daemon
it talks to over a unix socket. Tunnels are established from the local
machine; there is no remote-side component, and VS Code's automatic port
forwarding is unrelated to them.

- **Remote-SSH**: works as everywhere else, but the daemon and the
  tunnels live on your workstation, not on the remote host.
- **WSL**: not usable yet -- a Windows daemon would serve the named pipe
  this extension does not speak (see Platform support), and a daemon
  started inside WSL is not reachable from the Windows side over a unix
  socket. Until Windows support lands, use the portato TUI inside WSL.
- **Dev Containers**: same as Remote-SSH -- local daemon, local tunnels.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup, the checks CI
runs, repo conventions, the release process and the versioning policy.

## License

[MIT](LICENSE)
