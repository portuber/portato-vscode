// Pure status-bar rendering: state + connection facts -> text/tooltip.
// Kept free of vscode imports (tests bundle it without the vscode module);
// the caller injects the localizer, defaulting to identity so tests and
// plain-node consumers keep working.
// setContext stays in the controller: the "connecting" state must NOT flip
// the context key (see PortatoController.updateStatusBar), so the daemonRunning
// boolean is decided there, not here.

import { identityT, type Translate } from "./i18n";

export type BarState =
  | "disconnected"
  | "connecting"
  | "reconnecting"
  | "live"
  | "rejected";

export interface BarRender {
  text: string;
  tooltip: string;
}

export function renderBar(
  state: BarState,
  socket: string | undefined,
  connected: number,
  t: Translate = identityT,
): BarRender {
  switch (state) {
    case "disconnected":
      return {
        // Codicon ids stay OUTSIDE the translated string: a translator must
        // not be able to break "$(debug-disconnect)".
        text: `$(debug-disconnect) ${t("Portato: daemon not running")}`,
        tooltip: t("Start the Portato daemon to manage tunnels"),
      };
    case "connecting":
      return {
        // No socket yet: discovery has not resolved, and the previous
        // connection's path (if any) would be misleading here.
        text: `$(sync~spin) ${t("Portato: connecting...")}`,
        tooltip: t("Discovering the Portato daemon..."),
      };
    case "reconnecting":
      // Static icon, same rationale as the tree: this can sit for hours
      // while the daemon backs off against a dead peer, and the status bar
      // is visible even with the sidebar closed.
      return {
        text: `$(sync) ${t("Portato: reconnecting...")}`,
        tooltip: socket ?? t("Reconnecting to the Portato daemon..."),
      };
    case "live":
      return {
        text: `$(plug) ${t("Portato: {0} connected", connected)}`,
        tooltip: socket ?? "",
      };
    case "rejected":
      // The daemon answered 401: alive, but the IPC token mismatches.
      // Deliberately NOT "not running": a Start click would only lose the
      // single-instance flock ("daemon already running").
      return {
        text: `$(key) ${t("Portato: credentials rejected")}`,
        tooltip: t(
          "The daemon is running but rejects the extension's IPC token -- check portato.socketPath or restart the daemon",
        ),
      };
  }
}

/**
 * Decision for the portato:daemonRunning context key. Returns undefined when
 * nothing should be sent (and the cache left untouched), otherwise the value
 * to send AND cache. "connecting" never sends: the key must reflect a proven
 * connection, not a probe -- and its conceptual true value must not be
 * cached, or it would swallow the send on the transition to "live".
 * "rejected" counts as running: the daemon is up, and the view title must
 * offer Stop, not a Start that would lose the single-instance flock.
 */
export function contextSend(
  state: BarState,
  lastSent: boolean | undefined,
): boolean | undefined {
  if (state === "connecting") return undefined;
  const daemonRunning = state !== "disconnected";
  return daemonRunning === lastSent ? undefined : daemonRunning;
}
