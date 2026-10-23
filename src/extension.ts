import * as vscode from "vscode";
import type { Readable } from "node:stream";
import { DaemonClient } from "./daemonClient";
import { resolveSocketPath } from "./discovery";
import { settingOverride, startDaemon, stopDaemon } from "./daemonLifecycle";
import { PromptCoordinator } from "./prompts";
import { SseStream } from "./sse";
import { TunnelsTreeProvider, TuberItem } from "./treeProvider";
import type { TuberStatus } from "./types";

// Controller wiring: discovery -> client -> SSE -> tree/statusbar, plus the
// daemon lifecycle commands and the prompt coordinator. All re-discovery and
// token re-reads happen inside the SSE open() callback, so a daemon restart
// is picked up by the reconnect loop without any extra bookkeeping here.

const DISCONNECTED_POLL_MS = 10_000;

class PortatoController implements vscode.Disposable {
  readonly tree = new TunnelsTreeProvider();
  private readonly statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  private readonly coordinator: PromptCoordinator;
  private readonly sse: SseStream;

  private client: DaemonClient | undefined;
  /** The client backing the live SSE stream; destroyed once the stream dies. */
  private streamClient: DaemonClient | undefined;
  private socket: string | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private sseLive = false;
  private lastStatuses: TuberStatus[] = [];

  constructor() {
    this.coordinator = new PromptCoordinator({
      submit: (name, kind, value) => this.submitPrompt(name, kind, value),
    });
    this.sse = new SseStream(
      { open: () => this.openStream() },
      {
        onSignal: () => void this.refreshTubers(),
        onStreamChange: (open) => {
          if (!open) {
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
  async connect(): Promise<void> {
    if (this.disposed) return;
    clearTimeout(this.pollTimer);
    this.updateStatusBar("connecting");
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
      await this.refreshTubers();
      if (moveStream) this.sse.stop();
      this.sse.start();
    } catch {
      this.teardown();
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
    this.socket = client.socketPath;
    if (prev && prev !== client && prev !== this.streamClient) prev.destroy();
  }

  private teardown(): void {
    this.sse.stop();
    if (this.streamClient && this.streamClient !== this.client) {
      this.streamClient.destroy();
    }
    this.streamClient = undefined;
    this.client?.destroy();
    this.client = undefined;
    this.socket = undefined;
    this.tree.setDaemonState(undefined);
    this.updateStatusBar("disconnected");
  }

  private schedulePoll(): void {
    clearTimeout(this.pollTimer);
    if (this.disposed) return;
    this.pollTimer = setTimeout(() => void this.connect(), DISCONNECTED_POLL_MS);
  }

  private async makeClient(): Promise<DaemonClient> {
    const socket = await resolveSocketPath(probeDaemon, settingOverride());
    if (!socket) throw new Error("daemon not running");
    const client = await DaemonClient.create(socket);
    await client.healthz(); // wedged socket files must not count as "up"
    return client;
  }

  /** SSE (re)connect: fresh discovery + token read on every attempt. */
  private async openStream(): Promise<Readable> {
    const client = await this.makeClient();
    if (this.disposed) {
      client.destroy();
      throw new Error("disposed");
    }
    this.streamClient = client;
    this.adoptClient(client);
    this.tree.setDaemonState(client.socketPath);
    return client.eventsStream();
  }

  private async refreshTubers(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const statuses = await client.tubers();
      this.lastStatuses = statuses;
      this.tree.setStatuses(statuses);
      this.coordinator.sync(statuses);
      for (const s of statuses) this.coordinator.offer(s);
      this.updateStatusBar(this.sseLive ? "live" : "reconnecting");
    } catch {
      // Daemon went away mid-session: drop to the disconnected loop.
      this.teardown();
      this.schedulePoll();
    }
  }

  private async submitPrompt(
    name: string,
    kind: "hostkey" | "passphrase" | "password",
    value: string | undefined,
  ): Promise<void> {
    const client = this.client;
    if (!client) throw new Error("daemon not connected");
    if (kind === "hostkey") await client.acceptHost(name);
    else if (kind === "passphrase") await client.setPassphrase(name, value ?? "");
    else await client.setPassword(name, value ?? "");
    await this.refreshTubers();
  }

  async startDaemonCommand(): Promise<void> {
    try {
      await startDaemon();
      await this.connect();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`portato: failed to start daemon: ${msg}`);
    }
  }

  async stopDaemonCommand(): Promise<void> {
    try {
      const out = await stopDaemon();
      this.teardown();
      this.schedulePoll();
      if (out) void vscode.window.showInformationMessage(`portato: ${out}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`portato: failed to stop daemon: ${msg}`);
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
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`portato: ${name}: ${msg}`);
    }
  }

  private updateStatusBar(
    state: "disconnected" | "connecting" | "reconnecting" | "live",
  ): void {
    this.sseLive = state === "live";
    const connected = this.lastStatuses.filter((s) => s.state === "connected").length;
    switch (state) {
      case "disconnected":
        this.statusBar.text = "$(debug-disconnect) Portato: daemon not running";
        this.statusBar.tooltip = "Start the Portato daemon to manage tunnels";
        break;
      case "connecting":
        this.statusBar.text = "$(sync~spin) Portato: connecting...";
        this.statusBar.tooltip = this.socket;
        break;
      case "reconnecting":
        this.statusBar.text = "$(sync~spin) Portato: reconnecting...";
        this.statusBar.tooltip = this.socket;
        break;
      case "live":
        this.statusBar.text = `$(plug) Portato: ${connected} connected`;
        this.statusBar.tooltip = this.socket;
        break;
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.pollTimer);
    this.teardown();
    this.statusBar.dispose();
  }
}

async function probeDaemon(socketPath: string): Promise<boolean> {
  try {
    const client = await DaemonClient.create(socketPath, { timeoutMs: 300 });
    try {
      await client.healthz();
      return true;
    } finally {
      client.destroy();
    }
  } catch {
    return false;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = new PortatoController();
  vscode.window.registerTreeDataProvider("portatoTunnels", controller.tree);

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
  ];

  context.subscriptions.push(...disposables);
  // The socketPath override changes where discovery looks -- reconnect so a
  // GUI-launched window picks up the new setting without a reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("portato.socketPath")) void controller.connect();
    }),
  );
  void controller.connect();
}

export function deactivate(): void {}
