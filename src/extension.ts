import * as vscode from "vscode";
import type { Readable } from "node:stream";
import { homedir } from "node:os";
import { DaemonClient, probeSocket, httpStatusOf } from "./daemonClient";
import { planTunnelError, planPromptError, AuthEpisode } from "./errors";
import { resolveSocketPath } from "./discovery";
import { settingOverride, startDaemon, stopDaemon } from "./daemonLifecycle";
import { askLogLevel, LogsView } from "./logsView";
import { PromptCoordinator } from "./prompts";
import { identityCandidates, type IdentityCandidate } from "./identityPaths";
import { SseStream } from "./sse";
import { renderBar, contextSend, type BarState } from "./statusBar";
import { TunnelsTreeProvider, TuberItem } from "./treeProvider";
import { TuberFormController } from "./tuberForm";
import { matchesFilter, type TunnelFilter } from "./treeGroups";
import { pendingPrompt, isActive, type PromptKind, type TuberStatus } from "./types";

// Controller wiring: discovery -> client -> SSE -> tree/statusbar, plus the
// daemon lifecycle commands and the prompt coordinator. All re-discovery and
// token re-reads happen inside the SSE open() callback, so a daemon restart
// is picked up by the reconnect loop without any extra bookkeeping here.

const DISCONNECTED_POLL_MS = 10_000;

class PortatoController implements vscode.Disposable {
  /**
   * Host keys seen pending, by tuber. Shared with the tree (which applies
   * the mutation rules in updatePendingHosts) and with answerPrompt, so
   * promptFor can tell the post-accept handshake window from "nothing
   * pending" (pure logic in promptForPlan).
   */
  private readonly pendingHosts = new Map<string, string>();
  readonly tree = new TunnelsTreeProvider(this.pendingHosts, (name, steps) =>
    this.moveTuber(name, steps),
  );
  private readonly statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  private readonly coordinator: PromptCoordinator;
  private readonly sse: SseStream;
  private readonly forms: TuberFormController;
  /**
   * Polls GET /logs into the "Portato Logs" output channel. Started on a
   * proven connection, stopped on disconnect; the ring has no SSE events,
   * so polling is the only freshness mechanism.
   */
  private readonly logs = new LogsView(() => this.client);

  private client: DaemonClient | undefined;
  /** The client backing the live SSE stream; destroyed once the stream dies. */
  private streamClient: DaemonClient | undefined;
  private connectPromise: Promise<void> | undefined;
  /** Last portato:daemonRunning value actually sent to setContext. */
  private lastDaemonRunningSent: boolean | undefined;
  private socket: string | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private sseLive = false;
  private lastStatuses: TuberStatus[] = [];
  /**
   * Persistent-401 detection: a mismatch that survives fresh clients across
   * consecutive refresh cycles (each carrying a freshly-read token) is a
   * real token-file mismatch, not a daemon-restart race. See errors.ts.
   */
  private readonly authEpisode = new AuthEpisode();

  constructor() {
    this.coordinator = new PromptCoordinator({
      submit: (name, kind, value) => this.submitPrompt(name, kind, value),
    });
    this.forms = new TuberFormController({
      getClient: () => this.client,
      refresh: async () => {
        await this.refreshTubers();
      },
    });
    this.sse = new SseStream(
      { open: () => this.openStream() },
      {
        onSignal: () => void this.refreshTubers(),
        onStreamChange: (open) => {
          this.sseLive = open;
          if (open) {
            // The stream recovered on its own (daemon restart, hiccup):
            // resume log polling too, not only after an explicit connect().
            this.logs.start();
          } else {
            // The stream died: its client's keep-alive sockets are no longer
            // needed unless the client is still the current API client.
            if (this.streamClient && this.streamClient !== this.client) {
              this.streamClient.destroy();
            }
            this.streamClient = undefined;
          }
          this.updateStatusBar(open ? "live" : "reconnecting");
        },
      },
    );
    this.updateStatusBar("disconnected");
    this.statusBar.show();
  }

  /** Activate the connection: called on start, refresh, and on a timer. */
  async connect(opts: { quiet?: boolean } = {}): Promise<void> {
    if (this.disposed) return;
    // Single-flight: activation, the poll timer, Refresh, the socketPath
    // setting change and startDaemon can all call this concurrently; each
    // call would otherwise spawn a client and adoptClient() would destroy
    // the one an in-flight refreshTubers is using.
    if (this.connectPromise) {
      // A joiner (setting change, Start, Refresh) must not lose its trigger:
      // rerun once more after the in-flight attempt so every caller sees a
      // connect that started after its own trigger. The rerun is always
      // loud, so a user action never inherits the poll timer's quiet.
      this.connectAgain = true;
      return this.connectPromise;
    }
    let quiet = opts.quiet ?? false;
    let run!: Promise<void>;
    run = (async () => {
      try {
        do {
          this.connectAgain = false;
          // quiet covers the first pass of its own call only (the poll
          // timer's probe must not flash the "connecting" spinner); every
          // connectAgain rerun is loud, so a user action that joined an
          // in-flight quiet connect still gets visible feedback.
          await this.doConnect(quiet);
          quiet = false;
        } while (this.connectAgain);
      } finally {
        if (this.connectPromise === run) this.connectPromise = undefined;
      }
    })();
    this.connectPromise = run;
    return run;
  }

  private connectAgain = false;

  private async doConnect(quiet: boolean): Promise<void> {
    clearTimeout(this.pollTimer);
    // The poll timer probes silently: flashing the "connecting" spinner
    // every 10 s against a dead daemon is visual noise plus a renderer
    // repaint. User-triggered connects stay loud for visible feedback.
    if (!quiet) this.updateStatusBar("connecting");
    try {
      const client = await this.makeClient();
      // A live stream on a DIFFERENT socket (socketPath setting changed,
      // reconnect landed elsewhere) must move: sse.start() alone is a no-op
      // while running. stop() fires onStreamChange(false), which disposes the
      // old streamClient.
      const moveStream =
        this.streamClient !== undefined &&
        this.streamClient.socketPath !== client.socketPath;
      this.adoptClient(client);
      this.tree.setDaemonState(this.socket);
      if (!(await this.refreshTubers())) {
        // The daemon answered /healthz but /tubers failed: retry later
        // instead of starting SSE on top of a shaky connection. The daemon
        // itself is reachable, so keep the bar off the "connecting" spinner
        // and keep the context key honest.
        this.updateStatusBar(this.sseLive ? "live" : "reconnecting");
        this.schedulePoll();
        return;
      }
      if (moveStream) this.sse.stop();
      this.sse.start();
      this.logs.start();
    } catch (e) {
      if (httpStatusOf(e) === 401) {
        // authmw guards /healthz too: the daemon is alive but rejecting our
        // token. Release WITHOUT the "not running" presentation -- a Start
        // click would only lose the single-instance flock.
        this.releaseDaemon();
        this.showAuthRejected();
      } else {
        this.teardown();
      }
      this.schedulePoll();
    }
  }

  /**
   * Swap in a fresh client. The previous one is destroyed unless it still
   * backs the live SSE stream -- destroying that agent would kill the stream.
   */
  private adoptClient(client: DaemonClient): void {
    const prev = this.client;
    this.client = client;
    if (this.socket !== client.socketPath) this.logs.reset();
    this.socket = client.socketPath;
    if (prev && prev !== client && prev !== this.streamClient) prev.destroy();
  }

  private teardown(): void {
    this.releaseDaemon();
    this.tree.setDaemonState(undefined);
    this.updateStatusBar("disconnected");
  }

  /**
   * Resource half of teardown(): stops the stream and logs, destroys the
   * clients, clears the socket -- and touches NO UI. The 401 path pairs it
   * with showAuthRejected(): painting "not running" first would flash the
   * Start button and flap the daemonRunning context key every poll cycle.
   */
  private releaseDaemon(): void {
    this.sse.stop();
    this.logs.stop();
    if (this.streamClient && this.streamClient !== this.client) {
      this.streamClient.destroy();
    }
    this.streamClient = undefined;
    this.client?.destroy();
    this.client = undefined;
    this.socket = undefined;
  }

  private schedulePoll(): void {
    clearTimeout(this.pollTimer);
    if (this.disposed) return;
    this.pollTimer = setTimeout(
      () => void this.connect({ quiet: true }),
      DISCONNECTED_POLL_MS,
    );
  }

  private async makeClient(): Promise<DaemonClient> {
    const socket = await resolveSocketPath(probeSocket, settingOverride());
    if (!socket) throw new Error("daemon not running");
    const client = await DaemonClient.create(socket);
    await client.healthz(); // wedged socket files must not count as "up"
    // healthz passed -> the token matches: any earlier 401 episode is over.
    this.authEpisode.recordSuccess();
    return client;
  }

  /** SSE (re)connect: fresh discovery + token read on every attempt. */
  private async openStream(): Promise<Readable> {
    let client: DaemonClient;
    try {
      client = await this.makeClient();
    } catch (e) {
      // Discovery/healthz failed: the daemon is gone (or restarting). Show
      // the disconnected UI -- stale "connected" rows and a forever spinner
      // otherwise linger while the reconnect loop keeps polling. The stream
      // keeps retrying, so a returning daemon flips the UI back on success.
      // A 401 is the exception: the daemon is alive, only the token is off.
      if (!this.disposed) {
        if (httpStatusOf(e) === 401) this.showAuthRejected();
        else this.showDaemonGone();
      }
      throw e;
    }
    if (this.disposed) {
      client.destroy();
      throw new Error("disposed");
    }
    this.streamClient = client;
    this.adoptClient(client);
    this.tree.setDaemonState(client.socketPath);
    return client.eventsStream();
  }

  /** Disconnected presentation without tearing the SSE reconnect loop down. */
  private showDaemonGone(): void {
    this.lastStatuses = [];
    this.logs.stop();
    this.tree.setDaemonState(undefined);
    this.updateStatusBar("disconnected");
  }

  /**
   * Alive-but-rejecting presentation: /healthz answered 401, so the token
   * mismatches (e.g. a socketPath override whose token file lives
   * elsewhere). NOT "not running" -- a Start click would only lose the
   * single-instance flock. The episode message offers the two ways out;
   * the retry loops flip the UI back once the token reads right.
   */
  private showAuthRejected(): void {
    this.lastStatuses = [];
    this.logs.stop();
    this.maybeShowAuthMismatch();
    this.tree.setDaemonState(undefined, true);
    this.updateStatusBar("rejected");
  }

  /**
   * Re-fetch statuses. Returns false when the fetch failed on the CURRENT
   * client -- the caller must not start SSE on top of a dead connection.
   * A failure on a stale client (a newer connect() swapped it meanwhile)
   * reports success: the newcomer owns the UI and the caller must not
   * schedule a pointless poll. Daemon loss itself is detected by the
   * SSE reconnect path (openStream -> showDaemonGone), not by one bad GET.
   */
  private async refreshTubers(): Promise<boolean> {
    const client = this.client;
    if (!client) return false;
    try {
      const statuses = await client.tubers();
      this.authEpisode.recordSuccess();
      this.lastStatuses = statuses;
      this.tree.setStatuses(statuses);
      this.coordinator.sync(statuses);
      for (const s of statuses) this.coordinator.offer(s);
      this.updateStatusBar(this.sseLive ? "live" : "reconnecting");
      return true;
    } catch (e) {
      // One bad GET is not daemon loss -- the SSE watchdog and the reconnect
      // path decide that. A stale client's failure is not ours at all.
      if (client === this.client && httpStatusOf(e) === 401) {
        this.maybeShowAuthMismatch();
      }
      return client !== this.client;
    }
  }

  /**
   * The client already re-read the token once per call, and each poll cycle
   * builds a fresh client -- a 401 still failing now means the token file
   * genuinely mismatches the daemon. Explain once per episode and offer the
   * two ways out: recycle the daemon (regenerates the token) or check the
   * socketPath override that discovery latched onto.
   */
  private maybeShowAuthMismatch(): void {
    if (!this.authEpisode.record401()) return;
    const restart = vscode.l10n.t("Restart daemon");
    const settings = vscode.l10n.t("Open settings");
    void vscode.window
      .showErrorMessage(
        vscode.l10n.t(
          "portato: the daemon keeps rejecting the extension's credentials (IPC token mismatch)",
        ),
        restart,
        settings,
      )
      .then((pick) => {
        if (pick === restart) {
          void this.stopDaemonCommand().then(() => this.startDaemonCommand());
        } else if (pick === settings) {
          void vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "portato.socketPath",
          );
        }
      });
  }

  private async submitPrompt(
    name: string,
    kind: PromptKind,
    value: string | undefined,
  ): Promise<void> {
    const client = this.client;
    if (!client) throw new Error(vscode.l10n.t("daemon not connected"));
    try {
      if (kind === "hostkey") await client.acceptHost(name);
      else if (kind === "passphrase") await client.setPassphrase(name, value ?? "");
      else await client.setPassword(name, value ?? "");
    } catch (e) {
      // The tuber may have been deleted outside VS Code while its prompt was
      // up; heal the tree. The message mapping lives in prompts.ts.
      if (httpStatusOf(e) === 404) void this.refreshTubers();
      throw e;
    }
    await this.refreshTubers();
  }

  /**
   * Tree drag-and-drop: the daemon's move swaps with the element at
   * idx+delta, so the tree's insert intent arrives as a chain of +/-1
   * neighbor swaps (pure math in moveSteps). The steps run sequentially,
   * stop on the first failure, and re-render once at the end -- the daemon
   * may have applied a partial chain, and the tree must show that truth.
   */
  private async moveTuber(name: string, steps: readonly number[]): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      for (const step of steps) await client.move(name, step);
    } catch (e) {
      // The tree re-renders in finally either way; only the message is mapped.
      void vscode.window.showErrorMessage(
        planTunnelError(e, name, vscode.l10n.t).message,
      );
    } finally {
      await this.refreshTubers();
    }
  }

  /**
   * Quick-pick a tag (exact match) or a free-text substring to filter the
   * tree by. A filter disables drag-and-drop reorder, so it must be visible
   * in the UI: the "Clear Filter" button appears in the view title while one
   * is active.
   */
  async filterTunnelsCommand(): Promise<void> {
    const t = vscode.l10n.t;
    if (this.lastStatuses.length === 0) {
      void vscode.window.showInformationMessage(t("portato: no tunnels to filter"));
      return;
    }
    const tags = [
      ...new Set(
        this.lastStatuses.flatMap((s) => s.tags ?? []).filter((t) => t.trim() !== ""),
      ),
    ].sort();
    const byName = t("Filter by name...");
    const clear = t("Clear filter");
    const picks: (vscode.QuickPickItem & { filter?: TunnelFilter })[] = [
      ...tags.map((t) => ({ label: t, filter: { kind: "tag", value: t } as TunnelFilter })),
      { label: byName, description: t("substring on name or tag") },
      { label: clear },
    ];
    const pick = await vscode.window.showQuickPick(picks, {
      title: t("Filter tunnels"),
      placeHolder: t("Show only matching tunnels (tags or names)"),
    });
    if (!pick) return;
    if (pick.label === clear) {
      this.tree.setFilter(undefined);
      return;
    }
    let filter = pick.filter;
    if (pick.label === byName) {
      const input = await vscode.window.showInputBox({
        title: t("Filter tunnels"),
        prompt: t("Substring matched against tunnel names and tags"),
        ignoreFocusOut: true,
      });
      if (input === undefined) return;
      filter = { kind: "text", value: input };
    }
    this.tree.setFilter(filter);
    if (!filter) return;
    const shown = this.lastStatuses.filter((s) => matchesFilter(s, filter)).length;
    void vscode.window.showInformationMessage(
      t("portato: showing {0} of {1} tunnels", shown, this.lastStatuses.length),
    );
  }

  clearFilterCommand(): void {
    this.tree.setFilter(undefined);
  }

  /** Tree action: re-open a dismissed prompt for a blocked tuber. */
  answerPromptCommand(item?: TuberItem): void {
    // The tree item carries the snapshot it was built from; the pending flag
    // may have flipped since (e.g. a redial cleared it). Look up the fresh
    // status by name -- promptFor tells the user to wait when nothing is
    // pending anymore instead of silently doing nothing.
    const name = item?.status.name;
    const status = name
      ? this.lastStatuses.find((s) => s.name === name)
      : this.lastStatuses.find((s) => pendingPrompt(s) !== null);
    if (status) this.coordinator.promptFor(status, this.pendingHosts.has(status.name));
  }

  /**
   * Resolve which identity a tunnel uses (tuber -> defaults -> pending),
   * ask for the passphrase and hand it to the daemon's cache/store.
   */
  async storeIdentityCommand(item?: TuberItem): Promise<void> {
    const client = this.client;
    const name = item?.status.name;
    if (!client || !name) return;
    try {
      const candidates = identityCandidates(
        name,
        await client.config(),
        this.lastStatuses,
        homedir(),
      );
      if (candidates.length === 0) {
        void vscode.window.showErrorMessage(
          vscode.l10n.t("portato: {0}: no identity configured for this tunnel", name),
        );
        return;
      }
      // A single unambiguous candidate is taken silently; a noted one (the
      // shadowable default identity) always asks, so the user confirms
      // knowingly which key the phrase belongs to.
      let candidate: IdentityCandidate | undefined;
      const only = candidates.length === 1 ? candidates[0] : undefined;
      if (only && !only.note) {
        candidate = only;
      } else {
        const picked = await vscode.window.showQuickPick(
          candidates.map((c) => ({ label: c.path, description: c.note, candidate: c })),
          {
            title: vscode.l10n.t("Identity for tunnel {0}", name),
            placeHolder: vscode.l10n.t(
              "The daemon keys passphrases by the exact path",
            ),
          },
        );
        candidate = picked?.candidate;
      }
      if (!candidate) return;
      const path = candidate.path;
      // An empty passphrase is legitimate (a key without one) but must be a
      // confirmed choice -- with identity_passphrase_store on it also lands
      // in the OS keyring. Cancel re-opens the box, like the dial-time flow
      // in prompts.ts; Esc on the box is the only cancellation.
      let passphrase: string | undefined;
      for (;;) {
        passphrase = await vscode.window.showInputBox({
          title: vscode.l10n.t("Identity passphrase -- {0}", path),
          prompt: vscode.l10n.t("Passphrase to cache for {0}", path),
          password: true,
          ignoreFocusOut: true,
        });
        if (passphrase === undefined) return;
        if (passphrase !== "") break;
        const send = vscode.l10n.t("Store empty passphrase");
        const pick = await vscode.window.showWarningMessage(
          vscode.l10n.t("Store an EMPTY passphrase for {0}?", path),
          { modal: true },
          send,
        );
        if (pick === send) break;
      }
      await client.setIdentity(path, passphrase);
      await this.refreshTubers();
      void vscode.window.showInformationMessage(
        vscode.l10n.t("portato: passphrase stored for {0}", path),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(vscode.l10n.t("portato: {0}: {1}", name, msg));
    }
  }

  /** Drop the daemon's cached (and keyring-stored) passphrase for an identity. */
  async forgetIdentityCommand(item?: TuberItem): Promise<void> {
    const client = this.client;
    const name = item?.status.name;
    if (!client || !name) return;
    try {
      const candidates = identityCandidates(
        name,
        await client.config(),
        this.lastStatuses,
        homedir(),
      );
      if (candidates.length === 0) {
        void vscode.window.showErrorMessage(
          vscode.l10n.t("portato: {0}: no identity configured for this tunnel", name),
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        candidates.map((c) => ({ label: c.path, description: c.note })),
        {
          title: vscode.l10n.t("Forget passphrase for tunnel {0}", name),
          placeHolder: vscode.l10n.t("The next dial will prompt again"),
        },
      );
      if (!picked) return;
      const path = picked.label;
      await client.forgetIdentity(path);
      void vscode.window.showInformationMessage(
        vscode.l10n.t("portato: passphrase forgotten for {0}", path),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(vscode.l10n.t("portato: {0}: {1}", name, msg));
    }
  }

  async startDaemonCommand(): Promise<void> {
    try {
      await startDaemon();
      await this.connect();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(
        vscode.l10n.t("portato: failed to start daemon: {0}", msg),
      );
    }
  }

  showLogsCommand(name?: string): void {
    this.logs.show(name);
  }

  async setLogLevelCommand(): Promise<void> {
    const level = await askLogLevel(this.logs.getMinLevel());
    if (level !== undefined) this.logs.setMinLevel(level);
  }

  async stopDaemonCommand(): Promise<void> {
    try {
      const out = await stopDaemon();
      this.teardown();
      this.schedulePoll();
      if (out) void vscode.window.showInformationMessage(vscode.l10n.t("portato: {0}", out));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(
        vscode.l10n.t("portato: failed to stop daemon: {0}", msg),
      );
    }
  }

  async tunnelCommand(
    action: "enable" | "disable" | "restart",
    item: TuberItem | undefined,
  ): Promise<void> {
    const client = this.client;
    const name = item?.status.name;
    if (!client || !name) return;
    try {
      if (action === "enable") await client.enable(name);
      else if (action === "disable") await client.disable(name);
      else await client.restart(name);
      await this.refreshTubers();
    } catch (e) {
      const plan = planTunnelError(e, name, vscode.l10n.t);
      if (plan.staleItem) void this.refreshTubers();
      void vscode.window.showErrorMessage(plan.message);
    }
  }

  /** View title: add a tunnel through the webview form. */
  addTunnelCommand(): void {
    void this.forms.openAdd();
  }

  /** Tree context: edit a tunnel through the webview form. */
  editTunnelCommand(item?: TuberItem): void {
    const name = item?.status.name;
    if (name) void this.forms.openEdit(name);
  }

  /** Tree context: delete a tunnel after an explicit confirmation. */
  async deleteTunnelCommand(item?: TuberItem): Promise<void> {
    const client = this.client;
    const name = item?.status.name;
    if (!client || !name) return;
    const del = vscode.l10n.t("Delete");
    const pick = await vscode.window.showWarningMessage(
      vscode.l10n.t("Delete tunnel {0}?", name),
      { modal: true, detail: vscode.l10n.t("The daemon removes it from config.yaml.") },
      del,
    );
    if (pick !== del) return;
    try {
      await client.deleteTuber(name);
      await this.refreshTubers();
      void vscode.window.showInformationMessage(
        vscode.l10n.t("portato: tunnel {0} deleted", name),
      );
    } catch (e) {
      const plan = planTunnelError(e, name, vscode.l10n.t);
      if (plan.staleItem) void this.refreshTubers();
      void vscode.window.showErrorMessage(plan.message);
    }
  }

  /** View title: ask the daemon to reload config.yaml from disk. */
  async reloadConfigCommand(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      await client.reload();
      await this.refreshTubers();
      void vscode.window.showInformationMessage(vscode.l10n.t("portato: config reloaded"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // applyReload answers 500 with the validation error in {"error"}.
      void vscode.window.showErrorMessage(
        vscode.l10n.t("portato: reload failed: {0}", msg),
      );
    }
  }

  private updateStatusBar(state: BarState): void {
    // sseLive is owned by onStreamChange only; Refresh and the poll timer
    // call updateStatusBar("connecting") while a stream may already be live.
    const connected = this.lastStatuses.filter(isActive).length;
    const r = renderBar(state, this.socket, connected, vscode.l10n.t);
    // Skip no-op writes: repeated identical text/tooltip still cross into
    // the renderer (the poll loop and teardown hit this every 10 s).
    if (this.statusBar.text !== r.text) this.statusBar.text = r.text;
    if (this.statusBar.tooltip !== r.tooltip) this.statusBar.tooltip = r.tooltip;
    // The context key must reflect a proven daemon connection, not the label:
    // "connecting" runs before any probe, so flipping here would make the
    // toolbar swap Start<->Stop on every failed poll cycle.
    const ctx = contextSend(state, this.lastDaemonRunningSent);
    if (ctx !== undefined) {
      this.lastDaemonRunningSent = ctx;
      void vscode.commands.executeCommand(
        "setContext",
        "portato:daemonRunning",
        ctx,
      );
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.pollTimer);
    this.logs.dispose();
    this.teardown();
    this.statusBar.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = new PortatoController();
  // createTreeView (not registerTreeDataProvider): the view handle carries
  // the drag-and-drop controller for reorder; the provider contract
  // (onDidChangeTreeData) is unchanged.
  const view = vscode.window.createTreeView("portatoTunnels", {
    treeDataProvider: controller.tree,
    dragAndDropController: controller.tree,
  });
  context.subscriptions.push(view);

  const disposables = [
    controller,
    vscode.commands.registerCommand("portato.refresh", () => controller.connect()),
    vscode.commands.registerCommand("portato.startDaemon", () =>
      controller.startDaemonCommand(),
    ),
    vscode.commands.registerCommand("portato.stopDaemon", () =>
      controller.stopDaemonCommand(),
    ),
    vscode.commands.registerCommand("portato.enable", (item?: TuberItem) =>
      controller.tunnelCommand("enable", item),
    ),
    vscode.commands.registerCommand("portato.disable", (item?: TuberItem) =>
      controller.tunnelCommand("disable", item),
    ),
    vscode.commands.registerCommand("portato.restart", (item?: TuberItem) =>
      controller.tunnelCommand("restart", item),
    ),
    vscode.commands.registerCommand("portato.answerPrompt", (item?: TuberItem) =>
      controller.answerPromptCommand(item),
    ),
    vscode.commands.registerCommand("portato.storeIdentity", (item?: TuberItem) =>
      controller.storeIdentityCommand(item),
    ),
    vscode.commands.registerCommand("portato.forgetIdentity", (item?: TuberItem) =>
      controller.forgetIdentityCommand(item),
    ),
    vscode.commands.registerCommand("portato.filterTunnels", () =>
      controller.filterTunnelsCommand(),
    ),
    vscode.commands.registerCommand("portato.clearFilter", () =>
      controller.clearFilterCommand(),
    ),
    vscode.commands.registerCommand("portato.showLogs", () => controller.showLogsCommand()),
    vscode.commands.registerCommand("portato.showTuberLogs", (item?: TuberItem) =>
      controller.showLogsCommand(item?.status.name),
    ),
    vscode.commands.registerCommand("portato.setLogLevel", () =>
      controller.setLogLevelCommand(),
    ),
    vscode.commands.registerCommand("portato.addTunnel", () => controller.addTunnelCommand()),
    vscode.commands.registerCommand("portato.editTunnel", (item?: TuberItem) =>
      controller.editTunnelCommand(item),
    ),
    vscode.commands.registerCommand("portato.deleteTunnel", (item?: TuberItem) =>
      controller.deleteTunnelCommand(item),
    ),
    vscode.commands.registerCommand("portato.reloadConfig", () =>
      controller.reloadConfigCommand(),
    ),
  ];

  context.subscriptions.push(...disposables);
  // The socketPath override changes where discovery looks -- reconnect so a
  // GUI-launched window picks up the new setting without a reload. groupByTag
  // only changes how the already-fetched statuses render: re-render.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("portato.socketPath")) void controller.connect();
      if (e.affectsConfiguration("portato.groupByTag")) controller.tree.refresh();
    }),
  );
  void controller.connect();
}

export function deactivate(): void {}
