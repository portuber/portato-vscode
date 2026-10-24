# portato-vscode

VS Code extension -- a client for the [Portato](https://github.com/portuber/portato)
daemon: manage SSH port-forwarding tunnels from the sidebar (status, enable /
disable / restart, logs, passphrase prompts).

Status: skeleton. The extension is a thin client; the daemon, config and SSH
live in the `portato` Go binary.

## Development

```sh
npm install
npm run compile     # esbuild -> out/extension.js
npm run watch       # + F5 (Run Extension) in VS Code
npm run typecheck
```
