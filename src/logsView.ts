import * as vscode from "vscode";
import type { DaemonClient } from "./daemonClient";
import { formatLogEntry, levelRank, LogTail } from "./logDedup";
import type { LogEntry } from "./types";

// Poll-driven logs viewer. The daemon's ring does not emit SSE events, so
// the view polls GET /logs while a client connection exists and keeps an
// incremental, deduplicated buffer (LogTail). One output channel serves all
// tunnels; filtering to one tunnel re-renders the buffer instead of
// appending, so the visible text always matches the active filter.

const POLL_MS = 2000;
// The daemon ring holds at most 2000 entries; the buffer keeps headroom for
// a few ring rotations before the oldest entries drop off.
const MAX_ENTRIES = 5000;
// Output buffers only grow; past this many visible lines the view re-renders
// from scratch instead of appending forever.
const MAX_BUFFER_LINES = 8000;

export type LogLevel = "debug" | "info" | "warning" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: -4,
  info: 0,
  warning: 4,
  error: 8,
};

const LEVEL_PICKS: { level: LogLevel; label: string }[] = [
  { level: "debug", label: "Debug" },
  { level: "info", label: "Info" },
  { level: "warning", label: "Warning" },
  { level: "error", label: "Error" },
];

const GAP_MARKER =
  "--- earlier log entries were skipped (ring rotated or daemon restarted) ---";

/**
 * Marker kept in the buffer where a ring gap happened, so it survives
 * re-renders (filter/level changes, over-cap rewrites) and always sits
 * between the pre-gap and post-gap entries -- wherever the buffer moves it.
 */
const GAP_MARK: unique symbol = Symbol("gap");
type BufferItem = LogEntry | typeof GAP_MARK;

export class LogsView implements vscode.Disposable {
  // The "log" language id turns on the built-in log grammar (timestamps,
  // levels) without the view adding its own prefixes.
  private readonly channel = vscode.window.createOutputChannel("Portato Logs", "log");
  private readonly tail = new LogTail();
  private buffer: BufferItem[] = [];
  private filter: string | undefined;
  private minLevel: LogLevel = "info";
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private bufferedLines = 0;
  /**
   * Invalidates in-flight fetches: reset() (socket swap) and stop()
   * (disconnect) bump it, and a tick that started under an older
   * generation discards its result instead of poisoning the fresh buffer
   * with the previous daemon's ring.
   */
  private generation = 0;

  constructor(private readonly getClient: () => DaemonClient | undefined) {}

  /** Open the channel; a name restricts the view to one tunnel. */
  show(name?: string): void {
    this.filter = name;
    this.render();
    this.channel.show(true);
  }

  getMinLevel(): LogLevel {
    return this.minLevel;
  }

  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
    this.render();
  }

  /** Start polling (idempotent). The controller calls this on connect. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    void this.tick();
  }

  /** Stop polling (idempotent). The controller calls this on disconnect. */
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.generation++;
  }

  /** Forget the accumulated buffer (a different daemon socket took over). */
  reset(): void {
    this.generation++;
    this.tail.reset();
    this.buffer = [];
    this.bufferedLines = 0;
    // The channel must match the empty buffer; otherwise the old daemon's
    // lines linger and fresh ones pile up below them.
    this.channel.clear();
  }

  dispose(): void {
    this.stop(); // bumps the generation: in-flight results are dropped
    this.channel.dispose();
  }

  private matches(e: LogEntry): boolean {
    if (this.filter !== undefined && e.tuber !== this.filter) return false;
    const r = levelRank(e.level);
    if (r !== null && r < LEVEL_RANK[this.minLevel]) return false;
    return true;
  }

  private visible(): BufferItem[] {
    // The gap marker is positional: it shows whatever the filter/level,
    // sitting between the entries it separates.
    return this.buffer.filter((i) => i === GAP_MARK || this.matches(i));
  }

  private render(): void {
    const lines = this.visible().map((i) =>
      i === GAP_MARK ? GAP_MARKER : formatLogEntry(i),
    );
    this.channel.replace(lines.join("\n") + (lines.length ? "\n" : ""));
    this.bufferedLines = lines.length;
  }

  private async tick(): Promise<void> {
    // Ticks must not overlap: a slow fetch (daemon hiccup) would otherwise
    // pile up requests. A missed tick self-heals on the next interval.
    if (this.ticking) return;
    const client = this.getClient();
    if (!client) return;
    const generation = this.generation;
    this.ticking = true;
    try {
      const fetched = await client.logs();
      // A socket swap/reset/disconnect landed mid-fetch: the result belongs
      // to the previous daemon (or a stopped view) -- drop it.
      if (generation !== this.generation || this.getClient() !== client) return;
      const { entries, gap } = this.tail.diff(fetched);
      if (gap) this.buffer.push(GAP_MARK);
      if (entries.length > 0) {
        this.buffer.push(...entries);
        if (this.buffer.length > MAX_ENTRIES) {
          this.buffer.splice(0, this.buffer.length - MAX_ENTRIES);
        }
      }
      if (
        (this.filter !== undefined && (entries.length > 0 || gap)) ||
        this.bufferedLines > MAX_BUFFER_LINES
      ) {
        // Re-render paths: the filter needs the whole buffer re-applied and
        // an over-long buffer gets rewritten; the gap marker travels inside
        // the buffer, so both pick it up from there. A no-op poll under an
        // active filter must NOT re-render: constant full-buffer replaces
        // burn CPU and can yank the scroll position of a reader.
        this.render();
      } else {
        if (gap) {
          this.channel.appendLine(GAP_MARKER);
          this.bufferedLines += 1;
        }
        for (const e of entries) {
          if (!this.matches(e)) continue;
          this.channel.appendLine(formatLogEntry(e));
          this.bufferedLines += 1;
        }
      }
    } catch {
      // Transient fetch failure: daemon-loss detection belongs to the SSE
      // watchdog, so a dead poll here just skips a tick.
    } finally {
      this.ticking = false;
    }
  }
}

/** Quick-pick for the view-title "Set Log Level..." command. */
export async function askLogLevel(current: LogLevel): Promise<LogLevel | undefined> {
  const pick = await vscode.window.showQuickPick(
    LEVEL_PICKS.map((p) => ({
      ...p,
      description: p.level === current ? "current" : undefined,
    })),
    { title: "Portato Logs: minimum level", placeHolder: "Show entries at or above" },
  );
  return pick?.level;
}
