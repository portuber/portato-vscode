import { identityT, type Translate } from "./i18n";
import { endpoint, pendingPrompt, type TuberStatus } from "./types";
import { STATE_ICONS, stateLabel } from "./stateUi";

// Status-bar quick pick: daemon actions in a header section, one entry per
// tuber below (D-7 consult). Pure row building -- the controller maps
// PickerRow onto real QuickPickItems, because separators need
// vscode.QuickPickItemKind and this module stays testable without VS Code.
//
// Selecting a tuber blocked on a prompt OPENS THE PROMPT instead of
// toggling: the dial is blocked anyway, and a toggle would only hide the
// tunnel's problem. "Blocked" matches the tree's prompting rule exactly:
// pendingPrompt(s) or a remembered host key (the redial window after an
// accept, where promptFor answers "handshake in progress"). Any other
// tuber toggles enable/disable like the tree's inline controls, and a
// failed daemon call surfaces its error.

export type PickerAction =
  | { kind: "startDaemon" }
  | { kind: "stopDaemon" }
  | { kind: "restartDaemon" }
  | { kind: "showLogs" }
  | { kind: "addTunnel" }
  | { kind: "prompt"; status: TuberStatus }
  | { kind: "toggle"; status: TuberStatus; action: "enable" | "disable" };

export interface PickerRow {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly separator?: boolean;
  readonly action?: PickerAction;
}

export interface PickerContext {
  readonly daemonRunning: boolean;
  readonly statuses: readonly TuberStatus[];
  /** Mirrors the tree's remembered-host rule: name -> "prompting" row. */
  readonly isRememberedHost?: (name: string) => boolean;
}

export function buildPickRows(
  ctx: PickerContext,
  t: Translate = identityT,
): PickerRow[] {
  const rows: PickerRow[] = [{ label: t("Daemon"), separator: true }];
  if (!ctx.daemonRunning) {
    rows.push({
      label: `$(play) ${t("Start Daemon")}`,
      action: { kind: "startDaemon" },
    });
  } else {
    rows.push(
      {
        label: `$(debug-stop) ${t("Stop Daemon")}`,
        action: { kind: "stopDaemon" },
      },
      {
        label: `$(debug-restart) ${t("Restart Daemon")}`,
        action: { kind: "restartDaemon" },
      },
    );
  }
  rows.push({ label: `$(output) ${t("Show Logs")}`, action: { kind: "showLogs" } });
  if (ctx.daemonRunning) {
    rows.push({
      label: `$(add) ${t("Add Tunnel")}`,
      action: { kind: "addTunnel" },
    });
  }
  if (ctx.statuses.length > 0) {
    rows.push({ label: t("Tunnels"), separator: true });
    for (const s of ctx.statuses) {
      const prompting =
        pendingPrompt(s) !== null || ctx.isRememberedHost?.(s.name) === true;
      rows.push({
        label: `$(${STATE_ICONS[s.state]}) ${s.name}`,
        description: `${stateLabel(s.state, t)} -- ${endpoint(s)}`,
        detail: s.error ? t("Error: {0}", s.error) : undefined,
        action: prompting
          ? { kind: "prompt", status: s }
          : {
              kind: "toggle",
              status: s,
              action: s.state === "off" ? "enable" : "disable",
            },
      });
    }
  }
  return rows;
}
