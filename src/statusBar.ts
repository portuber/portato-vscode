// Pure status-bar rendering: state + connection facts -> text/tooltip.
// Kept free of vscode imports (tests bundle it without the vscode module).
// setContext stays in the controller: the "connecting" state must NOT flip
// the context key (see PortatoController.updateStatusBar), so the daemonRunning
// boolean is decided there, not here.

export type BarState = "disconnected" | "connecting" | "reconnecting" | "live";

export interface BarRender {
  text: string;
  tooltip: string;
}

export function renderBar(
  state: BarState,
  socket: string | undefined,
  connected: number,
): BarRender {

  switch (state) {
    case "disconnected":
      return {
        text: "$(debug-disconnect) Portato: daemon not running",
        tooltip: "Start the Portato daemon to manage tunnels",
      };
    case "connecting":
      return {
        // No socket yet: discovery has not resolved, and the previous
        // connection's path (if any) would be misleading here.
        text: "$(sync~spin) Portato: connecting...",
        tooltip: "Discovering the Portato daemon...",
      };
    case "reconnecting":
      // Static icon, same rationale as the tree: this can sit for hours
      // while the daemon backs off against a dead peer, and the status bar
      // is visible even with the sidebar closed.
      return {
        text: "$(sync) Portato: reconnecting...",
        tooltip: socket ?? "Reconnecting to the Portato daemon...",
      };
    case "live":
      return {
        text: `$(plug) Portato: ${connected} connected`,
        tooltip: socket ?? "",
      };
  }
}

/**
 * Decision for the portato:daemonRunning context key. Returns undefined when
 * nothing should be sent (and the cache left untouched), otherwise the value
 * to send AND cache. "connecting" never sends: the key must reflect a proven
 * connection, not a probe -- and its conceptual true value must not be
 * cached, or it would swallow the send on the transition to "live".
 */
export function contextSend(
  state: BarState,
  lastSent: boolean | undefined,
): boolean | undefined {
  if (state === "connecting") return undefined;
  const daemonRunning = state !== "disconnected";
  return daemonRunning === lastSent ? undefined : daemonRunning;
}
