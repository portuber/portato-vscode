import * as vscode from "vscode";
import { endpoint, pendingPrompt, type TuberStatus } from "./types";
import { updatePendingHosts } from "./pendingHosts";
import { groupsOf, matchesFilter, moveSteps, type TunnelFilter } from "./treeGroups";
import { STATE_ICONS, stateLabel } from "./stateUi";

// Sidebar tree: one item per tuber (flat, or grouped by first tag), state-
// driven icons, plus drag-and-drop reorder in the flat unfiltered list.
// The daemon-absent / rejected / no-tunnels states render through
// viewsWelcome (package.json, gated on the portato:viewState context key),
// not through message rows. Menus in package.json key on
// viewItem: "off" shows enable, everything else shows disable/restart, and
// "prompting" (a tuber blocked on a prompt) additionally shows answerPrompt.
//
// Element identity: VS Code keys selection/expansion by TreeItem.id, so
// every item carries a stable one. Tuber names are unique by daemon
// contract (duplicate POST -> 409) and the first-tag grouping shows each
// tuber exactly once, so the plain name is unique across the whole tree.

/** Recommended intra-tree mime type; the payload is { name: string }. */
export const TUNNEL_DRAG_MIME = "application/vnd.code.tree.portatotunnels";

/** Zero time (RFC3339) means "never connected" per the daemon contract. */
function connectedAtLabel(iso: string): string {
  if (iso.startsWith("0001-01-01")) return vscode.l10n.t("never");
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
   * The distinction keeps a spurious empty flash off the tree, because
   * setDaemonState runs before the first fetch. Both map to zero rows now:
   * the message states render through viewsWelcome (portato:viewState).
   */
  private statuses: TuberStatus[] | undefined;
  /**
   * Cached serialization of `statuses`, compared as a plain string so a
   * no-change poll costs one stringify of the incoming list, never of the
   * stored one.
   */
  private statusesKey: string | undefined;
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

  /** undefined socket = daemon not reachable; rows only, no message items. */
  setDaemonState(socketPath: string | undefined): void {
    if (this.daemonSocket === socketPath) return;
    this.daemonSocket = socketPath;
    this.statuses = undefined;
    this.statusesKey = undefined;
    this.pendingHosts.clear();
    this._onDidChange.fire();
  }

  setStatuses(statuses: TuberStatus[]): void {
    // The pending-host map is a pure function of the statuses: keep it
    // updated even on the no-op path below.
    updatePendingHosts(this.pendingHosts, statuses);
    // SSE signals fire refreshes on every state flip even when the payload
    // is byte-identical; skip the tree rebuild then. Key order is
    // deterministic (both lists come from Go's encoding/json via
    // client.tubers()), so stringify equality is value equality, and
    // stringify erases undefined-valued keys. The undefined -> [] transition
    // still fires (the "No tunnels configured" placeholder must appear), so
    // only a defined previous key can be compared. refresh()/setFilter()
    // bypass this and always re-render.
    const key = JSON.stringify(statuses);
    if (this.statusesKey !== undefined && this.statusesKey === key) return;
    this.statuses = statuses;
    this.statusesKey = key;
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
    const t = vscode.l10n.t;
    // Every message state -- daemon down, rejected token, no tunnels --
    // renders through viewsWelcome in package.json (gated on the
    // portato:viewState context key), so those states are zero rows here.
    // The one exception is "No tunnels match": tunnels exist, a filter
    // hides them, and that row stays actionable (clear the filter).
    if (this.statuses === undefined) return [];
    if (this.statuses.length === 0) return [];
    const visible = this.visible();
    if (visible.length === 0) {
      const item = new vscode.TreeItem(t("No tunnels match"), vscode.TreeItemCollapsibleState.None);
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
    super(
      tag === "" ? vscode.l10n.t("untagged") : tag,
      vscode.TreeItemCollapsibleState.Expanded,
    );
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
    const t = vscode.l10n.t;
    const item = new TuberItem(s, s.name, tag);
    const state = s.state;
    const label = stateLabel(state, t);
    item.description = `${endpoint(s)} -- ${label}${s.error ? t(" (see tooltip)") : ""}`;
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
        title: t("Answer Prompt"),
        arguments: [item],
      };
    }
    const lines = [
      t("Name: {0}", s.name),
      t("Type: {0}", s.type),
      t("Endpoint: {0}", endpoint(s)),
      t("State: {0}", label),
      t("Connected at: {0}", connectedAtLabel(s.connected_at)),
    ];
    if (s.tags?.length) lines.push(t("Tags: {0}", s.tags.join(", ")));
    if (s.error) lines.push(t("Error: {0}", s.error));
    if (s.pending_host) lines.push(t("Pending host key: {0}", s.pending_host));
    if (s.pending_passphrase) lines.push(t("Pending passphrase: {0}", s.pending_passphrase));
    if (s.pending_password) lines.push(t("Pending password: {0}", s.pending_password));
    item.tooltip = lines.join("\n");
    return item;
  }
}
