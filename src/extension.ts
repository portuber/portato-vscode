import * as vscode from "vscode";
import type { Readable } from "node:stream";
import { homedir } from "node:os";
import { join } from "node:path";
import { DaemonClient, probeSocket, httpStatusOf } from "./daemonClient";
import { planTunnelError, AuthEpisode } from "./errors";
import { resolveSocketPath, configHome } from "./discovery";
import { settingOverride, startDaemon, stopDaemon, binaryPath, socketOverrideArgs } from "./daemonLifecycle";
import { askLogLevel, LogsView, type LogLevel } from "./logsView";
import { PromptCoordinator } from "./prompts";
import { identityCandidates, type IdentityCandidate } from "./identityPaths";
import { SseStream } from "./sse";
import { renderBar, contextSend, attentionCount, type BarState } from "./statusBar";
import { TunnelsTreeProvider, TuberItem, TagGroupItem } from "./treeProvider";
import { TuberFormController } from "./tuberForm";
import { matchesFilter, type TunnelFilter } from "./treeGroups";
import { pendingPrompt, isActive, type PromptKind, type TuberStatus } from "./types";
import { buildPickRows, type PickerAction } from "./quickPick";
import { deriveViewState } from "./viewState";
import { classifyVersion, MIN_DAEMON_VERSION } from "./daemonVersion";
import { isBinaryAvailable } from "./binaryCheck";
import { diagWarn, diagInfo, disposeDiagnostics } from "./diagnostics";
import { browserUrl, localAddress, socksUrl, resolvedSocks5User } from "./addrUrl";
import { runCliCapture } from "./cliRun";
import {
  parseImportPreview,
  groupImportBlocks,
  hostsForSelection,
  countImported,
  importArgv,
  type ImportRow,
} from "./importView";

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
  // -- viewsWelcome facts (portato:viewState; derivation is pure) ---------
  /** undefined = the async binary check has not answered yet. */
  private binaryAvailable: boolean | undefined;
  /** undefined = before the first connect attempt -- never guess. */
  private daemonUp: boolean | undefined;
  private authRejected = false;
  /** false until a successful /tubers fetch on the current daemon. */
  private statusesFetched = false;
  private lastViewStateSent: string | undefined;
  /** Last badge background applied; undefined = none (plain bar). */
  private lastBadgeBgSent: string | undefined;
  /** (socket, version) pairs already warned about this window session. */
  private readonly versionWarned = new Set<string>();
  // -- autoStartDaemon (D-5 verdict constraints) ---------------------------
  /** One shot per window session, success or failure. */
  private autostartAttempted = false;
  /** A user-initiated Stop cancels auto-start for the rest of the session. */
  private userStopped = false;
  /**
   * Persistent-401 detection: a mismatch that survives fresh clients across
   * consecutive refresh cycles (each carrying a freshly-read token) is a
   * real token-file mismatch, not a daemon-restart race. See errors.ts.
   */
  private readonly authEpisode = new AuthEpisode();

  constructor() {
    this.coordinator = new PromptCoordinator({
      submit: (name, kind, value) => this.submitPrompt(name, kind, value),
      refetch: (name) => this.refetchStatus(name),
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
    // Clicking the bar opens the quick pick (daemon actions + tuber
    // toggles); a bar without a command reads as a passive label.
    this.statusBar.command = "portato.statusPicker";
    // Pin the context key to "loading" before any await: viewsWelcome must
    // never flash the "daemon not running" Start button during discovery.
    this.syncViewState();
    this.statusBar.show();
  }

  /**
   * portato:viewState gates the tree's viewsWelcome contents (loading |
   * noBinary | stopped | rejected | empty | ok; pure math in viewState.ts).
   * Cached like the other context keys -- setContext crosses into the
   * renderer on every call.
   */
  private syncViewState(): void {
    const v = deriveViewState({
      binaryAvailable: this.binaryAvailable,
      daemonUp: this.daemonUp,
      authRejected: this.authRejected,
      tuberCount: this.statusesFetched ? this.lastStatuses.length : undefined,
    });
    if (v === this.lastViewStateSent) return;
    this.lastViewStateSent = v;
    void vscode.commands.executeCommand("setContext", "portato:viewState", v);
  }

  /**
   * Informational toasts only; they obey portato.showNotifications. Errors,
   * warnings and the prompt toasts (prompts.ts) never pass through here --
   * silencing those would hide exactly the things that need a reaction
   * (consult verdict).
   */
  private inform(msg: string): void {
    if (!vscode.workspace.getConfiguration("portato").get<boolean>("showNotifications", true)) {
      return;
    }
    void vscode.window.showInformationMessage(msg);
  }

  /**
   * portato.minLogLevel seeds the daemon log filter; the Set Log Level
   * command stays a per-session override on top.
   */
  applyMinLogLevelSetting(): void {
    const raw = vscode.workspace.getConfiguration("portato").get<string>("minLogLevel");
    const level: LogLevel =
      raw === "debug" || raw === "info" || raw === "warning" || raw === "error"
        ? raw
        : "info";
    this.logs.setMinLevel(level);
  }

  /**
   * autoStartDaemon, fired once from activation only (never from the poll
   * timer or the SSE reconnect path): the daemon must be absent, the
   * binary must resolve, and no user Stop may have happened this session.
   */
  async maybeAutoStartDaemon(): Promise<void> {
    if (this.autostartAttempted) return;
    this.autostartAttempted = true;
    if (!vscode.workspace.getConfiguration("portato").get<boolean>("autoStartDaemon")) {
      return;
    }
    if (this.userStopped || this.daemonUp) return;
    const bin = await isBinaryAvailable(binaryPath(), process.env.PATH ?? "");
    if (!bin) {
      diagWarn("autoStartDaemon: the configured binary does not resolve; skipping");
      return;
    }
    diagInfo("autoStartDaemon: daemon absent; starting");
    await this.startDaemonCommand();
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
    // The definite-assignment split is a TypeScript requirement, not a
    // runtime one: the async body reads `run` in its finally, and tsc's
    // analysis rejects a self-referencing const initializer with TS2454
    // (a closure may run before the initializer completes). At runtime the
    // read only happens after the first await has yielded.
    let run!: Promise<void>;
    // eslint-disable-next-line prefer-const -- see above
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
      // dispose() ran while discovery/healthz was in flight: its teardown
      // already released everything. The late client must not be adopted
      // (nobody would destroy it again) and nothing may start.
      if (this.disposed) {
        client.destroy();
        return;
      }
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
      if (this.disposed) return;
      if (moveStream) this.sse.stop();
      this.sse.start();
      // start() is a no-op while the stream sits in its reconnect backoff
      // (up to 30 s after the daemon died); the healthz above proves the
      // daemon is back, so kick the remaining wait and connect now. kick()
      // is itself a no-op unless a reconnect timer is pending -- so the
      // fresh-activation path (start() already connecting) stays at one
      // open, no duplicate discovery/adoption.
      this.sse.kick();
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
    this.daemonUp = false;
    this.authRejected = false;
    this.statusesFetched = false;
    this.lastStatuses = [];
    this.syncViewState();
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
    const hz = await client.healthz(); // wedged socket files must not count as "up"
    // healthz passed -> the token matches: any earlier 401 episode is over.
    this.authEpisode.recordSuccess();
    this.checkDaemonVersion(hz.version, socket);
    return client;
  }

  /**
   * Daemon-version surfacing (warning-only by consult verdict): the check
   * re-runs on every (re)connect, and the (socket, version) dedupe keeps a
   * reconnect loop from re-toasting the same fact. A daemon upgrade that
   * lands on a new below-MIN or unknown version warns again -- correctly.
   */
  private checkDaemonVersion(version: string | undefined, socket: string): void {
    const verdict = classifyVersion(version);
    if (verdict === "ok") return;
    const key = `${socket}|${version ?? ""}`;
    if (this.versionWarned.has(key)) return;
    this.versionWarned.add(key);
    const msg =
      verdict === "belowMin"
        ? vscode.l10n.t(
            "portato: daemon version {0} is older than the recommended {1} -- some features may misbehave",
            version ?? "?",
            MIN_DAEMON_VERSION,
          )
        : verdict === "unrecognized"
          ? // "dev" builds and pre-release tags: a value came back, we just
            // cannot vouch for it -- do NOT claim the daemon is old.
            vscode.l10n.t(
              "portato: unrecognized daemon version {0} -- version check skipped",
              version ?? "?",
            )
          : vscode.l10n.t(
              "portato: could not determine the daemon version (portato older than {0}?)",
              MIN_DAEMON_VERSION,
            );
    void vscode.window.showWarningMessage(msg);
    diagWarn(msg);
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
    // healthz passed inside makeClient: the daemon is up. Statuses are not
    // fetched yet on this adopt -- the SSE first frame refetches at once,
    // and until then viewState stays "loading" (no welcome flash).
    this.daemonUp = true;
    this.authRejected = false;
    this.statusesFetched = false;
    this.syncViewState();
    return client.eventsStream();
  }

  /** Disconnected presentation without tearing the SSE reconnect loop down. */
  private showDaemonGone(): void {
    this.lastStatuses = [];
    this.daemonUp = false;
    this.authRejected = false;
    this.statusesFetched = false;
    this.syncViewState();
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
    this.daemonUp = true; // answered 401: provably alive
    this.authRejected = true;
    this.statusesFetched = false;
    this.syncViewState();
    this.logs.stop();
    this.maybeShowAuthMismatch();
    this.tree.setDaemonState(undefined);
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
  private refreshSeq = 0;

  private async refreshTubers(): Promise<boolean> {
    const client = this.client;
    if (!client) return false;
    const seq = ++this.refreshSeq;
    try {
      const statuses = await client.tubers();
      // Concurrent refreshes (SSE signal + user action) interleave: an
      // OLDER fetch resolving last must not regress the tree to stale
      // statuses. Only the newest refresh sequence applies its payload.
      if (client !== this.client || seq !== this.refreshSeq) return true;
      this.authEpisode.recordSuccess();
      this.lastStatuses = statuses;
      // A successful fetch proves the daemon end to end: pin the welcome
      // facts before rendering, so ok/empty never lag behind the tree.
      this.daemonUp = true;
      this.authRejected = false;
      this.statusesFetched = true;
      this.syncViewState();
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
   * Fresh single-tuber status for the host-key accept re-check
   * (prompts.ts -> hostKeyVerify): fetched, never read from lastStatuses,
   * because the modal may have outlived several status updates.
   */
  private async refetchStatus(name: string): Promise<TuberStatus | undefined> {
    const client = this.client;
    if (!client) return undefined;
    try {
      // Deliberately not applied to the tree: the submit flow's own
      // refreshTubers follows immediately and owns the rendering.
      return (await client.tubers()).find((s) => s.name === name);
    } catch {
      return undefined; // unreachable daemon = nothing verifiable = abort
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
        if (pick === restart) void this.restartDaemonSequence();
        else if (pick === settings) {
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
      this.inform(t("portato: no tunnels to filter"));
      return;
    }
    const tags = [
      ...new Set(
        this.lastStatuses.flatMap((s) => s.tags ?? []).filter((t) => t.trim() !== ""),
      ),
    ].sort();
    const byName = t("Filter by name...");
    const clear = t("Clear filter");
    type FilterPick = vscode.QuickPickItem & { filter?: TunnelFilter };
    const picks: FilterPick[] = [
      ...tags.map(
        (tag): FilterPick => ({ label: tag, filter: { kind: "tag", value: tag } }),
      ),
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
    this.inform(t("portato: showing {0} of {1} tunnels", shown, this.lastStatuses.length));
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
        vscode.l10n.t,
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
      this.inform(vscode.l10n.t("portato: passphrase stored for {0}", path));
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
        vscode.l10n.t,
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
      this.inform(vscode.l10n.t("portato: passphrase forgotten for {0}", path));
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
      const out = await this.stopDaemonCore();
      if (out) this.inform(vscode.l10n.t("portato: {0}", out));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(
        vscode.l10n.t("portato: failed to stop daemon: {0}", msg),
      );
    }
  }

  /**
   * Stop core (teardown first, then CLI stop); THROWS on failure so chained flows
   * (restart) can distinguish "stopped" from "stop failed" -- a follow-up
   * start after a failed stop would only bounce off the daemon's flock.
   */
  private async stopDaemonCore(): Promise<string> {
    // A user-driven stop (Stop button, restart chain): auto-start stays
    // off for the rest of the window session (D-5 verdict).
    this.userStopped = true;
    // D5 mitigation (consult verdict): the SSE stream and client go down
    // BEFORE the CLI stop, along with any armed poll timer -- a timer
    // firing mid-stop would re-adopt the dying daemon and restart SSE on
    // it. The finally block re-arms the poll loop either way, so a failed
    // stop (daemon still alive) is followed by a quiet reconnect instead
    // of a dead view.
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.teardown();
    try {
      return await stopDaemon();
    } finally {
      this.schedulePoll();
    }
  }

  /** Stop then start, halting at the first failure with its own message. */
  private async restartDaemonSequence(): Promise<void> {
    try {
      const out = await this.stopDaemonCore();
      if (out) this.inform(vscode.l10n.t("portato: {0}", out));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(
        vscode.l10n.t("portato: failed to stop daemon: {0}", msg),
      );
      return;
    }
    await this.startDaemonCommand();
  }

  async tunnelCommand(
    action: "enable" | "disable" | "restart",
    item: TuberItem | undefined,
  ): Promise<void> {
    const name = item?.status.name;
    if (name) await this.tunnelAction(action, name);
  }

  /** Name-based core shared by the tree items and the quick pick. */
  private async tunnelAction(
    action: "enable" | "disable" | "restart",
    name: string,
  ): Promise<void> {
    const client = this.client;
    if (!client) return;
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

  /**
   * Status-bar click: the quick pick (daemon actions + per-tuber rows; pure
   * building in quickPick.ts). A tuber blocked on a prompt opens that
   * prompt instead of toggling -- the dial is blocked either way.
   */
  async statusPickerCommand(): Promise<void> {
    const t = vscode.l10n.t;
    const rows = buildPickRows(
      {
        daemonRunning: this.lastDaemonRunningSent ?? false,
        statuses: this.lastStatuses,
        isRememberedHost: (name) => this.pendingHosts.has(name),
      },
      t,
    );
    const items = rows.map((r) => ({
      label: r.label,
      description: r.description,
      detail: r.detail,
      kind: r.separator ? vscode.QuickPickItemKind.Separator : undefined,
      action: r.action,
    }));
    const picked = (await vscode.window.showQuickPick(items, {
      title: t("Portato"),
      placeHolder: t("Pick a daemon action or a tunnel to toggle"),
      matchOnDescription: true,
      matchOnDetail: true,
    })) as { action?: PickerAction } | undefined;
    const action = picked?.action;
    if (!action) return;
    switch (action.kind) {
      case "startDaemon":
        return this.startDaemonCommand();
      case "stopDaemon":
        return this.stopDaemonCommand();
      case "restartDaemon":
        return this.restartDaemonSequence();
      case "showLogs":
        return this.showLogsCommand();
      case "addTunnel":
        return this.addTunnelCommand();
      case "prompt":
        return this.coordinator.promptFor(
          action.status,
          this.pendingHosts.has(action.status.name),
        );
      case "toggle":
        return this.tunnelAction(action.action, action.status.name);
    }
  }

  /** noBinary welcome: async, never gates activation. */
  async refreshBinaryAvailable(): Promise<void> {
    const available = await isBinaryAvailable(binaryPath(), process.env.PATH ?? "");
    if (this.binaryAvailable === available) return;
    this.binaryAvailable = available;
    this.syncViewState();
  }

  openLandingCommand(): void {
    void vscode.env.openExternal(vscode.Uri.parse("https://portuber.github.io/portato/"));
  }

  /** View title: add a tunnel through the webview form. */
  addTunnelCommand(): void {
    this.forms.openAdd();
  }

  /** Tree context: edit a tunnel through the webview form. */
  editTunnelCommand(item?: TuberItem): void {
    const name = item?.status.name;
    if (name) void this.forms.openEdit(name);
  }

  /**
   * Tree context: copy the local endpoint, wildcard binds normalized to
   * the loopback (pure builder in addrUrl.ts).
   */
  copyAddressCommand(item?: TuberItem): void {
    const addr = item ? localAddress(item.status) : undefined;
    if (!addr) return;
    void vscode.env.clipboard.writeText(addr);
    this.inform(vscode.l10n.t("portato: copied {0}", addr));
  }

  /** Tree context: open a local forward in the default browser. */
  openInBrowserCommand(item?: TuberItem): void {
    const url = item ? browserUrl(item.status) : undefined;
    if (!url) return;
    void vscode.env.openExternal(vscode.Uri.parse(url));
  }

  /**
   * Tree context: copy the SOCKS URL of a dynamic tunnel. The username
   * follows the daemon's ResolvedSocks5User rule -- the tuber's own
   * socks5_user wins when non-blank, otherwise the config default applies
   * (the mirror lives in addrUrl.ts). The password is never embedded and
   * neither the URL nor the config body is ever logged.
   */
  async copySocksUrlCommand(item?: TuberItem): Promise<void> {
    const client = this.client;
    const status = item?.status;
    if (!client || !status) return;
    if (status.type !== "dynamic") return;
    let user = "";
    try {
      const cfg = await client.config();
      // Mirror the daemon's ResolvedSocks5User: the tuber's own value
      // wins over the default (see addrUrl.ts).
      const raw = cfg.tubers.find((t) => t.name === status.name);
      user = resolvedSocks5User(raw?.socks5_user, cfg.defaults.socks5_user);
    } catch {
      // No config, no username: the bare URL is still correct.
    }
    const url = socksUrl(status, user);
    if (!url) return;
    void vscode.env.clipboard.writeText(url);
    this.inform(vscode.l10n.t("portato: copied {0}", url));
  }

  /** Tag-group context: filter the tree down to this tag. */
  filterTagCommand(item?: TagGroupItem): void {
    if (item?.tag !== undefined) this.tree.setFilter({ kind: "tag", value: item.tag });
  }

  /** Tag-group context: add a tunnel preseeded with this tag. */
  addTunnelWithTagCommand(item?: TagGroupItem): void {
    this.forms.openAdd(item?.tag);
  }

  /**
   * Palette: import forwards from ~/.ssh/config through the CLI -- the
   * importer itself is the CLI's, never reimplemented here. The dry-run
   * preview feeds a quick pick whose unit of selection is the ssh BLOCK:
   * `portato import` matches host patterns, so picking any forward of a
   * block imports the whole block (the pick says so). The real run passes
   * the deduplicated hosts as argv through execFile (no shell) with --yes;
   * importArgv puts them after `--` so a pattern that starts with "-" is
   * never read as a flag. It writes config.yaml directly, and the daemon's
   * own config watcher + the SSE refresh surface the new tunnels without
   * any extension-side filewatcher.
   */
  async importSshCommand(): Promise<void> {
    const dry = await runCliCapture(binaryPath(), ["import", "--all", "--dry-run"]);
    if (dry.code !== 0) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t("portato: import failed: {0}", dry.stderr.trim() || dry.stdout.trim()),
      );
      return;
    }
    const parsed = parseImportPreview(dry.stdout);
    if (parsed.kind === "empty") {
      this.inform(vscode.l10n.t("nothing new to import from ~/.ssh/config"));
      return;
    }
    if (parsed.kind === "unparsed") {
      // Lenient by design, but never guess: surface the raw plan instead.
      diagWarn("import preview could not be parsed", parsed.raw);
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          "could not parse the import preview -- the raw output is in the Portato Diagnostics channel",
        ),
      );
      return;
    }
    const items: Array<vscode.QuickPickItem & { row?: ImportRow }> = [];
    for (const block of groupImportBlocks(parsed.rows)) {
      items.push({ label: block.host, kind: vscode.QuickPickItemKind.Separator });
      for (const row of block.rows) {
        items.push({
          label: row.name,
          description: row.type,
          detail: vscode.l10n.t("{0} (ssh: {1})", row.spec, row.host),
          row,
          picked: true,
        });
      }
    }
    const chosen = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      matchOnDescription: true,
      matchOnDetail: true,
      placeHolder: vscode.l10n.t(
        "pick ssh blocks to import -- selecting any forward imports its whole block",
      ),
    });
    if (!chosen || chosen.length === 0) return;
    const hosts = hostsForSelection(
      parsed.rows,
      new Set(chosen.flatMap((c) => (c.row ? [c.row.name] : []))),
    );
    if (hosts.length === 0) return;
    const res = await runCliCapture(binaryPath(), importArgv(hosts));
    if (res.code !== 0) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t("portato: import failed: {0}", res.stderr.trim() || res.stdout.trim()),
      );
      return;
    }
    const count =
      countImported(res.stdout) ||
      parsed.rows.filter((r) => hosts.includes(r.host)).length;
    this.inform(vscode.l10n.t("imported {0} tunnel(s) from ~/.ssh/config (added disabled)", count));
  }

  /**
   * Palette: `portato doctor` in a VS Code terminal. A terminal whose
   * shellPath is the binary itself closes the moment doctor exits and the
   * report is lost, so a tiny sh wrapper runs the binary with argv only
   * ("$0" "$@" -- the machine-scoped binary path and literal flags, no
   * user-controlled text is ever re-parsed by a shell) and then parks the
   * terminal on the exit code. isTransient keeps a window reload from
   * resurrecting the session (--probe really dials every host).
   */
  doctorCommand(probe: boolean): void {
    const args = ["doctor"];
    if (probe) args.push("--probe");
    // Check the same daemon this extension talks to when an override is set.
    args.push(...socketOverrideArgs());
    const terminal = vscode.window.createTerminal({
      name: probe ? "portato doctor --probe" : "portato doctor",
      shellPath: "/bin/sh",
      shellArgs: [
        "-c",
        '"$0" "$@"; code=$?; printf "\\n[exit %s] press Enter to close" "$code"; read _',
        binaryPath(),
        ...args,
      ],
      isTransient: true,
    });
    terminal.show();
  }

  /**
   * Palette: open the daemon's config.yaml. The path is computed from the
   * same ConfigHome logic discovery uses; a daemon started with a custom
   * --config is invisible to the extension, so this is our best truth.
   * A missing file is info (the daemon creates it on first start); any
   * other failure to reach or open it is a real error.
   */
  async openConfigCommand(): Promise<void> {
    const file = join(configHome(), "portato", "config.yaml");
    const uri = vscode.Uri.file(file);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch (e) {
      if (e instanceof vscode.FileSystemError && e.code === "FileNotFound") {
        void vscode.window.showInformationMessage(
          vscode.l10n.t("{0} does not exist yet -- the daemon creates it on first start", file),
        );
        return;
      }
      void vscode.window.showErrorMessage(
        vscode.l10n.t("cannot open {0}: {1}", file, String(e)),
      );
      return;
    }
    await vscode.window.showTextDocument(uri);
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
      this.inform(vscode.l10n.t("portato: tunnel {0} deleted", name));
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
      this.inform(vscode.l10n.t("portato: config reloaded"));
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
    // Badge tally (consult verdict): error tubers + blocked prompts -- see
    // the pure attentionCount; the controller only feeds the statuses.
    const attention = attentionCount(this.lastStatuses);
    const r = renderBar(state, this.socket, connected, attention, vscode.l10n.t);
    // Skip no-op writes: repeated identical text/tooltip still cross into
    // the renderer (the poll loop and teardown hit this every 10 s).
    if (this.statusBar.text !== r.text) this.statusBar.text = r.text;
    if (this.statusBar.tooltip !== r.tooltip) this.statusBar.tooltip = r.tooltip;
    const bg = r.attention > 0 ? "statusBarItem.warningBackground" : undefined;
    if (bg !== this.lastBadgeBgSent) {
      this.lastBadgeBgSent = bg;
      this.statusBar.backgroundColor = bg
        ? new vscode.ThemeColor(bg)
        : undefined;
    }
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
    // The diagnostics channel is created lazily on first write; this thin
    // disposable disposes it whenever it happens to exist by shutdown.
    new vscode.Disposable(disposeDiagnostics),
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
    vscode.commands.registerCommand("portato.statusPicker", () =>
      controller.statusPickerCommand(),
    ),
    vscode.commands.registerCommand("portato.openLanding", () =>
      controller.openLandingCommand(),
    ),
    vscode.commands.registerCommand("portato.copyAddress", (item?: TuberItem) =>
      controller.copyAddressCommand(item),
    ),
    vscode.commands.registerCommand("portato.openInBrowser", (item?: TuberItem) =>
      controller.openInBrowserCommand(item),
    ),
    vscode.commands.registerCommand("portato.copySocksUrl", (item?: TuberItem) =>
      controller.copySocksUrlCommand(item),
    ),
    vscode.commands.registerCommand("portato.filterTag", (item?: TagGroupItem) =>
      controller.filterTagCommand(item),
    ),
    vscode.commands.registerCommand("portato.addTunnelWithTag", (item?: TagGroupItem) =>
      controller.addTunnelWithTagCommand(item),
    ),
    vscode.commands.registerCommand("portato.importSsh", () => controller.importSshCommand()),
    vscode.commands.registerCommand("portato.doctor", () => controller.doctorCommand(false)),
    vscode.commands.registerCommand("portato.doctorProbe", () => controller.doctorCommand(true)),
    vscode.commands.registerCommand("portato.openConfig", () => controller.openConfigCommand()),
  ];

  context.subscriptions.push(...disposables);
  // The socketPath override changes where discovery looks -- reconnect so a
  // GUI-launched window picks up the new setting without a reload. groupByTag
  // only changes how the already-fetched statuses render: re-render.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("portato.socketPath")) void controller.connect();
      if (e.affectsConfiguration("portato.binaryPath")) {
        void controller.refreshBinaryAvailable();
      }
      if (e.affectsConfiguration("portato.groupByTag")) controller.tree.refresh();
      if (e.affectsConfiguration("portato.minLogLevel")) {
        controller.applyMinLogLevelSetting();
      }
    }),
  );
  // Seed the daemon log filter from the setting (a per-session override
  // via Set Log Level... still wins afterwards).
  controller.applyMinLogLevelSetting();
  // The noBinary welcome needs the binary check; it runs in the background
  // and only ever refines "stopped" into "noBinary" (never blocks startup).
  void controller.refreshBinaryAvailable();
  // The initial connect settles first: auto-start only fires for a daemon
  // that stayed absent (never from the poll/reconnect paths).
  void controller.connect().then(() => controller.maybeAutoStartDaemon());
}

export function deactivate(): void {}
