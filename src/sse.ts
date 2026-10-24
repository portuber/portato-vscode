import type { Readable } from "node:stream";

// SSE consumer for GET /events over the unix socket.
//
// Protocol facts (internal/daemon/server.go, handleEvents):
//   - every frame is a signal-only `data: {}` -- no payload; the reaction is
//     to re-fetch GET /tubers
//   - the first frame arrives immediately on connect, so it also drives the
//     initial load -- no separate initial fetch is needed
//   - a `: heartbeat` comment every 15 s keeps the stream alive; treat
//     >45 s of silence as a dead stream
//   - log changes do NOT produce events
//
// EventSource cannot be used over a unix socket, so this is a line-based
// parser over the response stream with reconnect + backoff. Re-discovery and
// token re-read happen OUTSIDE this class: the caller passes a fresh `open`
// on every reconnect (it rebuilds DaemonClient from discovery each time).

export interface SseEvents {
  /** Debounced signal -- re-fetch GET /tubers. */
  onSignal(): void;
  /** Stream opened/closed (e.g. to show a "live" indicator). */
  onStreamChange?(open: boolean): void;
}

export interface SseDeps {
  /**
   * Opens (or re-opens) GET /events. Must resolve with the raw byte stream
   * and reject when the HTTP call itself fails (connect refused, >=400).
   * Called again on every reconnect -- the caller may re-run discovery and
   * rebuild the client/token between calls.
   */
  open(): Promise<Readable>;
}

export interface SseOptions {
  /** Silence budget; the daemon heartbeats every 15 s. Default 45_000. */
  watchdogMs?: number;
  /** First reconnect delay. Default 1_000. */
  initialBackoffMs?: number;
  /** Reconnect delay ceiling. Default 30_000. */
  maxBackoffMs?: number;
  /** Coalesce bursts of frames into one onSignal. Default 100. */
  debounceMs?: number;
}

const DEFAULTS = {
  watchdogMs: 45_000,
  initialBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  debounceMs: 100,
};

export class SseStream {
  private readonly watchdogMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly debounceMs: number;

  private watchdog?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private current?: Readable;
  private streamOpen = false;
  private backoff: number;
  private running = false;
  // Bumped on start()/stop(); timers and the pump capture it so a late
  // callback from a torn-down generation can never fire into a new one.
  private generation = 0;

  constructor(
    private readonly deps: SseDeps,
    private readonly events: SseEvents,
    opts: SseOptions = {},
  ) {
    const o = { ...DEFAULTS, ...opts };
    this.watchdogMs = o.watchdogMs;
    this.initialBackoffMs = o.initialBackoffMs;
    this.maxBackoffMs = o.maxBackoffMs;
    this.debounceMs = o.debounceMs;
    this.backoff = o.initialBackoffMs;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation++;
    void this.connect();
  }

  stop(): void {
    this.running = false;
    this.generation++;
    clearTimeout(this.watchdog);
    clearTimeout(this.debounce);
    clearTimeout(this.reconnectTimer);
    this.watchdog = undefined;
    this.debounce = undefined;
    this.reconnectTimer = undefined;
    this.current?.destroy();
    this.current = undefined;
    if (this.streamOpen) {
      this.streamOpen = false;
      this.events.onStreamChange?.(false);
    }
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    const gen = this.generation;
    try {
      const stream = await this.deps.open();
      if (!this.running || gen !== this.generation) {
        stream.destroy();
        return;
      }
      this.current = stream;
      this.backoff = this.initialBackoffMs;
      this.streamOpen = true;
      this.events.onStreamChange?.(true);
      this.resetWatchdog(gen);
      await this.pump(stream, gen);
    } catch {
      // Connect refused / HTTP error / header timeout -- reconnect below.
    } finally {
      // A stale watchdog must not destroy the NEXT connection's stream --
      // and a stale generation must not clear the CURRENT one's watchdog.
      if (gen === this.generation) clearTimeout(this.watchdog);
      if (this.running && gen === this.generation) {
        if (this.streamOpen) {
          this.streamOpen = false;
          this.events.onStreamChange?.(false);
        }
        this.scheduleReconnect(gen);
      }
    }
  }

  private async pump(stream: Readable, gen: number): Promise<void> {
    let buf = "";
    try {
      for await (const chunk of stream) {
        if (!this.running || gen !== this.generation) return;
        buf += (chunk as Buffer).toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) this.handleLine(line, gen);
      }
    } catch {
      // Stream error or watchdog destroy -- reconnect below.
    }
  }

  private handleLine(line: string, gen: number): void {
    // ANY traffic -- signal frames and `: heartbeat` comments alike -- proves
    // the stream is alive, so it always resets the watchdog.
    this.resetWatchdog(gen);
    const l = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (l.startsWith("data:")) this.scheduleSignal(gen);
  }

  private scheduleSignal(gen: number): void {
    if (!this.running || gen !== this.generation || this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      if (this.running && gen === this.generation) this.events.onSignal();
    }, this.debounceMs);
  }

  private resetWatchdog(gen: number): void {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (this.running && gen === this.generation) this.current?.destroy();
    }, this.watchdogMs);
  }

  private scheduleReconnect(gen: number): void {
    clearTimeout(this.reconnectTimer);
    const delay = this.backoff;
    this.reconnectTimer = setTimeout(() => {
      if (!this.running || gen !== this.generation) return;
      this.backoff = Math.min(this.backoff * 2, this.maxBackoffMs);
      void this.connect();
    }, delay);
  }
}
