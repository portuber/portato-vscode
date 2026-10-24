import * as vscode from "vscode";
import { endpoint, pendingPrompt, type TuberStatus, type TuberState } from "./types";

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

export class TunnelsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private daemonSocket: string | undefined;
  private statuses: TuberStatus[] = [];

  /** undefined socket = daemon not reachable; the view offers Start. */
  setDaemonState(socketPath: string | undefined): void {
    if (this.daemonSocket === socketPath) return;
    this.daemonSocket = socketPath;
    if (!socketPath) this.statuses = [];
    this._onDidChange.fire();
  }

  setStatuses(statuses: TuberStatus[]): void {
    this.statuses = statuses;
    this._onDidChange.fire();
  }

  refresh(): void {
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
    return this.statuses.map((s) => TuberItem.fromStatus(s));
  }
}

export class TuberItem extends vscode.TreeItem {
  constructor(
    readonly status: TuberStatus,
    label: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
  }

  static fromStatus(s: TuberStatus): TuberItem {
    const item = new TuberItem(s, s.name);
    const state = s.state;
    item.description = `${endpoint(s)} -- ${state}${s.error ? " (see tooltip)" : ""}`;
    item.iconPath = new vscode.ThemeIcon(STATE_ICONS[state]);
    // A tuber blocked on a prompt gets its own contextValue so package.json
    // can offer portato.answerPrompt; other menu when-clauses (!= off) keep
    // matching it, so disable/restart stay available.
    const prompting = pendingPrompt(s) !== null;
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
      `Connected at: ${s.connected_at}`,
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
