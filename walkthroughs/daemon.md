# Start the daemon

The extension never spawns a daemon silently -- it drives a running one.
When no daemon is running, the Portato view shows a **Start daemon**
button.

[Start the daemon now](command:portato.startDaemon)

Prefer it automatic? Set `portato.autoStartDaemon` and the view starts
one when it opens (at most once per window, never after you stop the
daemon yourself). An externally started daemon -- terminal, service
manager -- is picked up automatically, and if VS Code cannot find the
`portato` binary, point `portato.binaryPath` at it.
