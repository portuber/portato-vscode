import * as vscode from "vscode";
import { endpoint, pendingPrompt, type TuberStatus, type TuberState } from "./types";
import { updatePendingHosts } from "./pendingHosts";

// Sidebar tree: one item per tuber, state-driven icons, plus the
// daemon-absent state with a Start action. Menus in package.json key on
// viewItem: "off" shows enable, everything else shows disable/restart, and
// "prompting" (a tuber blocked on a prompt) additionally shows answerPrompt.

const STATE_ICONS: Record<TuberState, string> = {
  off: "circle-slash",
  connecting: "sync~spin",
  connected: "circle-filled",
  reconnecting: "sync~spin",
  error: "error",
};

/** Zero time (RFC3339) means "never connected" per the daemon contract. */
function connectedAtLabel(iso: string): string {
  if (iso.startsWith("0001-01-01")) return "never";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export class TunnelsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private daemonSocket: string | undefined;
  /**
   * undefined = not fetched yet for the current daemon; [] = fetched, empty.
   * The distinction keeps "No tunnels configured" from flashing on every
   * connect/reconnect, because setDaemonState runs before the first fetch.
   */
  private statuses: TuberStatus[] | undefined;
  /**
   * Host keys seen pending, by tuber. The daemon clears `pending_host` during
   * the connecting phase of a redial, so keying "prompting" off the live
   * status alone would flicker the contextValue (and its inline action).
   * Mutation rules live in updatePendingHosts (pure, unit-tested).
   */
  private readonly pendingHosts = new Map<string, string>();

  /** undefined socket = daemon not reachable; the view offers Start. */
  setDaemonState(socketPath: string | undefined): void {
    if (this.daemonSocket === socketPath) return;
    this.daemonSocket = socketPath;
    this.statuses = undefined;
    this.pendingHosts.clear();
    this._onDidChange.fire();
  }

  setStatuses(statuses: TuberStatus[]): void {
    this.statuses = statuses;
    updatePendingHosts(this.pendingHosts, statuses);
    this._onDidChange.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.ProviderResult<vscode.TreeItem[]> {
    if (!this.daemonSocket) {
      const item = new vscode.TreeItem(
        "Daemon not running",
        vscode.TreeItemCollapsibleState.None,
      );
      item.description = "start it to manage tunnels";
      item.iconPath = new vscode.ThemeIcon("debug-disconnect");
      item.command = {
        command: "portato.startDaemon",
        title: "Start Daemon",
      };
      return [item];
    }
    if (this.statuses === undefined) return [];
    if (this.statuses.length === 0) {
      const item = new vscode.TreeItem(
        "No tunnels configured",
        vscode.TreeItemCollapsibleState.None,
      );
      item.description = "add one in the portato config";
      item.iconPath = new vscode.ThemeIcon("info");
      return [item];
    }
    return this.statuses.map((s) => TuberItem.fromStatus(s, this.pendingHosts));
  }
}

export class TuberItem extends vscode.TreeItem {
  constructor(
    readonly status: TuberStatus,
    label: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
  }

  static fromStatus(
    s: TuberStatus,
    pendingHosts?: ReadonlyMap<string, string>,
  ): TuberItem {
    const item = new TuberItem(s, s.name);
    const state = s.state;
    item.description = `${endpoint(s)} -- ${state}${s.error ? " (see tooltip)" : ""}`;
    item.iconPath = new vscode.ThemeIcon(STATE_ICONS[state]);
    // A tuber blocked on a prompt gets its own contextValue so package.json
    // can offer portato.answerPrompt; other menu when-clauses (!= off) keep
    // matching it, so disable/restart stay available. A remembered host key
    // keeps "prompting" stable through the redial window where the daemon
    // briefly clears pending_host.
    const prompting = pendingPrompt(s) !== null || (pendingHosts?.has(s.name) ?? false);
    item.contextValue = prompting ? "prompting" : state;
    if (prompting) {
      // Single click re-opens the prompt (the dial blocks without bumping
      // attempts, so the notification alone can never re-ask).
      item.command = {
        command: "portato.answerPrompt",
        title: "Answer Prompt",
        arguments: [item],
      };
    }
    const lines = [
      `Name: ${s.name}`,
      `Type: ${s.type}`,
      `Endpoint: ${endpoint(s)}`,
      `State: ${state}`,
      `Connected at: ${connectedAtLabel(s.connected_at)}`,
    ];
    if (s.tags?.length) lines.push(`Tags: ${s.tags.join(", ")}`);
    if (s.error) lines.push(`Error: ${s.error}`);
    if (s.pending_host) lines.push(`Pending host key: ${s.pending_host}`);
    if (s.pending_passphrase) lines.push(`Pending passphrase: ${s.pending_passphrase}`);
    if (s.pending_password) lines.push(`Pending password: ${s.pending_password}`);
    item.tooltip = lines.join("\n");
    return item;
  }
}
