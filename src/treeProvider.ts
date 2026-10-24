import * as vscode from "vscode";
import { endpoint, pendingPrompt, type TuberStatus, type TuberState } from "./types";
import { updatePendingHosts } from "./pendingHosts";
import { groupsOf, matchesFilter, moveSteps, type TunnelFilter } from "./treeGroups";

// Sidebar tree: one item per tuber (flat, or grouped by first tag), state-
// driven icons, the daemon-absent state with a Start action, plus drag-and-
// drop reorder in the flat unfiltered list. Menus in package.json key on
// viewItem: "off" shows enable, everything else shows disable/restart, and
// "prompting" (a tuber blocked on a prompt) additionally shows answerPrompt.
//
// Element identity: VS Code keys selection/expansion by TreeItem.id, so
// every item carries a stable one. Tuber names are unique by daemon
// contract (duplicate POST -> 409) and the first-tag grouping shows each
// tuber exactly once, so the plain name is unique across the whole tree.

const STATE_ICONS: Record<TuberState, string> = {
  off: "circle-slash",
  connecting: "sync~spin",
  connected: "circle-filled",
  // Static icon on purpose: reconnecting can last for hours (daemon backoff
  // against a dead host), and a spinning ThemeIcon forces a constant renderer
  // repaint for as long as the view is visible. "connecting" is short-lived,
  // so it keeps the spinner.
  reconnecting: "sync",
  error: "error",
};

/** Recommended intra-tree mime type; the payload is { name: string }. */
export const TUNNEL_DRAG_MIME = "application/vnd.code.tree.portatotunnels";

/** Zero time (RFC3339) means "never connected" per the daemon contract. */
function connectedAtLabel(iso: string): string {
  if (iso.startsWith("0001-01-01")) return "never";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export class TunnelsTreeProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.TreeDragAndDropController<vscode.TreeItem>
{
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  readonly dropMimeTypes = [TUNNEL_DRAG_MIME];
  readonly dragMimeTypes = [TUNNEL_DRAG_MIME];

  private daemonSocket: string | undefined;
  /**
   * undefined = not fetched yet for the current daemon; [] = fetched, empty.
   * The distinction keeps "No tunnels configured" from flashing on every
   * connect/reconnect, because setDaemonState runs before the first fetch.
   */
  private statuses: TuberStatus[] | undefined;
  private filter: TunnelFilter | undefined;
  /** Set while a drop's move round-trip is in flight; drops meanwhile are ignored. */
  moveInFlight = false;

  constructor(
    /**
     * Shared with the controller so answerPrompt can consult it (pure logic
     * in promptForPlan). Owned here for mutation rules; see updatePendingHosts.
     */
    private readonly pendingHosts: Map<string, string> = new Map(),
    /**
     * Performs the reorder as a chain of +/-1 moves; the controller owns
     * the daemon client. Receives the steps from moveSteps verbatim.
     */
    private readonly onMove?: (name: string, steps: readonly number[]) => Promise<void>,
  ) {}

  /** Grouped by first tag; read from the setting so toggles need no copy here. */
  private get grouped(): boolean {
    return vscode.workspace.getConfiguration("portato").get<boolean>("groupByTag") ?? false;
  }

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

  /** Re-render on setting toggles the provider reads lazily (groupByTag). */
  refresh(): void {
    this._onDidChange.fire();
  }

  setFilter(filter: TunnelFilter | undefined): void {
    // A blank text filter filters nothing; normalize it away so the context
    // key and the DnD guard see a clean "no filter" state.
    this.filter = filter?.kind === "text" && filter.value.trim() === "" ? undefined : filter;
    void vscode.commands.executeCommand(
      "setContext",
      "portato:filterActive",
      this.filter !== undefined,
    );
    this._onDidChange.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getParent(element: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem> {
    if (element instanceof TuberItem && element.tag !== undefined) {
      return new TagGroupItem(element.tag);
    }
    return undefined;
  }

  getChildren(element?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
    if (!element) return this.roots();
    if (element instanceof TagGroupItem) {
      return this.visible(element.tag).map((s) =>
        TuberItem.fromStatus(s, this.pendingHosts, element.tag),
      );
    }
    return [];
  }

  private roots(): vscode.TreeItem[] {
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
    const visible = this.visible();
    if (visible.length === 0) {
      const item = new vscode.TreeItem("No tunnels match", vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("info");
      return [item];
    }
    if (this.grouped) {
      return groupsOf(visible).map((g) => new TagGroupItem(g.tag));
    }
    return visible.map((s) => TuberItem.fromStatus(s, this.pendingHosts));
  }

  /** Statuses passing the filter; with `tag`, those whose first tag it is. */
  private visible(tag?: string): TuberStatus[] {
    const all = (this.statuses ?? []).filter((s) => matchesFilter(s, this.filter));
    if (tag === undefined) return all;
    return all.filter((s) => (s.tags?.[0] ?? "") === tag);
  }

  // -- Drag and drop -------------------------------------------------------
  // Reorder is offered only in the plain flat list: with grouping or a
  // filter the visible positions no longer equal the config positions
  // (groups bucket non-contiguous ranges; filters hide rows), so a drop
  // would compute deltas against the wrong indices. In those modes the
  // handlers no-op; the drag simply does nothing.

  handleDrag(source: readonly vscode.TreeItem[], dataTransfer: vscode.DataTransfer): void {
    if (this.grouped || this.filter || this.moveInFlight) return;
    const item = source.find((i): i is TuberItem => i instanceof TuberItem);
    if (!item) return;
    dataTransfer.set(TUNNEL_DRAG_MIME, new vscode.DataTransferItem({ name: item.status.name }));
  }

  async handleDrop(
    target: vscode.TreeItem | undefined,
    dataTransfer: vscode.DataTransfer,
  ): Promise<void> {
    if (this.grouped || this.filter || !this.onMove || this.moveInFlight) return;
    const payload = dataTransfer.get(TUNNEL_DRAG_MIME)?.value as { name?: string } | undefined;
    if (!payload?.name) return;
    // Drop on the root appends at the end; drop on a row takes its position.
    // The daemon's move swaps with a neighbor, so the insert is emulated by
    // a chain of +/-1 moves (pure math in moveSteps).
    if (target !== undefined && !(target instanceof TuberItem)) return;
    const order = (this.statuses ?? []).map((s) => s.name);
    const targetIndex =
      target === undefined ? undefined : order.indexOf(target.status.name);
    if (targetIndex !== undefined && targetIndex < 0) return;
    const steps = moveSteps(order, payload.name, targetIndex);
    if (steps === null) return;
    this.moveInFlight = true;
    try {
      await this.onMove(payload.name, steps);
    } finally {
      this.moveInFlight = false;
    }
  }
}

export class TagGroupItem extends vscode.TreeItem {
  constructor(readonly tag: string) {
    super(tag === "" ? "untagged" : tag, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `tag:${tag}`;
    this.contextValue = "tagGroup";
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

export class TuberItem extends vscode.TreeItem {
  constructor(
    readonly status: TuberStatus,
    label: string,
    /** First-tag group this row renders under; undefined in the flat list. */
    readonly tag?: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    // Unique by daemon contract (duplicate names are rejected) and each
    // tuber renders exactly once, also in the first-tag grouped mode.
    this.id = status.name;
  }

  static fromStatus(
    s: TuberStatus,
    pendingHosts?: ReadonlyMap<string, string>,
    tag?: string,
  ): TuberItem {
    const item = new TuberItem(s, s.name, tag);
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
