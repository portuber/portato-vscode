# portato-vscode

VS Code extension -- a client for the [Portato](https://github.com/portuber/portato)
daemon: manage SSH port-forwarding tunnels from the sidebar (status, enable /
disable / restart, logs, passphrase prompts).

Status: part 1 (MVP) implemented -- discovery, daemon client, SSE, tunnels
tree, prompts, daemon lifecycle, unit + integration tests.

## Platform support

macOS and Linux only. The daemon's Windows build serves a named pipe
(`\\.\pipe\portato`, see `internal/daemon/paths_windows.go`) and this
extension does not implement that transport yet; on Windows it degrades to
"daemon not running". Full Windows support is a planned, separately tested
task.

## Development

```sh
npm install
npm run compile     # esbuild -> out/extension.js
npm run watch       # + F5 (Run Extension) in VS Code
npm run typecheck
```
