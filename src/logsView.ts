import * as vscode from "vscode";
import type { DaemonClient } from "./daemonClient";
import {
  applyPoll,
  formatLogEntry,
  GAP_MARK,
  levelRank,
  LogTail,
  tickPlan,
  type BufferItem,
} from "./logDedup";
import { BASE_POLL_MS, nextDelayMs, shouldPoll } from "./logsPoll";
import type { LogEntry } from "./types";

// Poll-driven logs viewer. The daemon's ring does not emit SSE events, so
// the view polls GET /logs while a client connection exists and keeps an
// incremental, deduplicated buffer (LogTail). One output channel serves all
// tunnels; new entries append through the active filter, and only
// filter/level changes and the visible-line cap re-render the whole buffer.

// The daemon ring holds at most 2000 entries; the buffer keeps headroom for
// a few ring rotations before the oldest entries drop off.
const MAX_ENTRIES = 5000;
// The channel only grows (head-trims of the buffer are silent -- output
// channels cannot delete lines); past this many visible lines the view
// re-renders from scratch instead of appending forever.
const MAX_BUFFER_LINES = 8000;

export type LogLevel = "debug" | "info" | "warning" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: -4,
  info: 0,
  warning: 4,
  error: 8,
};

// Labels translate at access time, as literal vscode.l10n.t arguments --
// the l10n bundle extractor only collects string literals inside t(...)
// calls, so t(someKey) would silently miss the bundle.
const LEVEL_PICKS: { level: LogLevel; label: () => string }[] = [
  { level: "debug", label: () => vscode.l10n.t("Debug") },
  { level: "info", label: () => vscode.l10n.t("Info") },
  { level: "warning", label: () => vscode.l10n.t("Warning") },
  { level: "error", label: () => vscode.l10n.t("Error") },
];

/** Localized at render time: the marker must follow the UI locale. */
function gapMarker(): string {
  return vscode.l10n.t("--- earlier log entries were skipped (ring rotated or daemon restarted) ---");
}

export class LogsView implements vscode.Disposable {
  // The "log" language id turns on the built-in log grammar (timestamps,
  // levels) without the view adding its own prefixes.
  private readonly channel = vscode.window.createOutputChannel("Portato Logs", "log");
  private readonly tail = new LogTail();
  private buffer: BufferItem[] = [];
  private filter: string | undefined;
  private minLevel: LogLevel = "info";
  /**
   * setTimeout chain (not setInterval: the delay is adaptive). Undefined
   * means no poll is scheduled or running; tick() re-arms itself.
   */
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private bufferedLines = 0;
  // Poll gates, see src/logsPoll.ts: connection state from start()/stop(),
  // and the one-way "channel was shown at least once" ratchet -- VS Code
  // exposes no output-channel visibility, so everShown never goes back to
  // false and polling continues even after the user closes the panel.
  private connected = false;
  private everShown = false;
  /** Consecutive polls that produced nothing; drives the backoff. */
  private idleTicks = 0;
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
    // First visibility or a fresh look: poll eagerly and at full speed.
    this.everShown = true;
    this.idleTicks = 0;
    this.kick();
  }

  getMinLevel(): LogLevel {
    return this.minLevel;
  }

  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
    // The re-render below can reveal previously filtered entries; do not
    // let a stale idle count delay the next poll.
    this.idleTicks = 0;
    this.render();
  }

  /**
   * Note that a daemon connection exists (idempotent). The controller
   * calls this on connect and SSE recovery; polling only starts when the
   * channel has been shown at least once (see logsPoll.ts).
   */
  start(): void {
    this.connected = true;
    // A stop()/start() cycle is a reconnect: assume the ring moved.
    this.idleTicks = 0;
    this.kick();
  }

  /** Note the connection is gone (idempotent); halts polling. */
  stop(): void {
    this.connected = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.generation++;
  }

  /** Forget the accumulated buffer (a different daemon socket took over). */
  reset(): void {
    this.generation++;
    this.idleTicks = 0;
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

  /** (Re)start the poll loop with an immediate tick, if the gates allow. */
  private kick(): void {
    if (!shouldPoll(this.connected, this.everShown)) return;
    if (this.ticking) return; // its finally block re-arms the chain
    if (this.timer !== undefined) clearTimeout(this.timer);
    void this.tick();
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
      i === GAP_MARK ? gapMarker() : formatLogEntry(i),
    );
    this.channel.replace(lines.join("\n") + (lines.length ? "\n" : ""));
    this.bufferedLines = lines.length;
  }

  private async tick(): Promise<void> {
    // Ticks must not overlap: a slow fetch (daemon hiccup) would otherwise
    // pile up requests. A missed tick self-heals on the next timeout.
    if (this.ticking) return;
    this.ticking = true;
    try {
      const client = this.getClient();
      // No client (between teardown and the next connect): a skipped tick;
      // the finally block keeps the chain armed like setInterval did.
      if (!client) return;
      const generation = this.generation;
      const fetched = await client.logs();
      // A socket swap/reset/disconnect landed mid-fetch: the result belongs
      // to the previous daemon (or a stopped view) -- drop it.
      if (generation !== this.generation || this.getClient() !== client) return;
      const diff = this.tail.diff(fetched);
      // Backoff bookkeeping, post-guard: only a fully quiet poll counts,
      // and a caught fetch error below leaves the counter untouched (a
      // network hiccup is not a quiet ring).
      this.idleTicks = diff.entries.length === 0 && !diff.gap ? this.idleTicks + 1 : 0;
      const { buffer, added } = applyPoll(this.buffer, diff, MAX_ENTRIES);
      this.buffer = buffer;
      // Head-trims are silent: the channel cannot delete the trimmed lines
      // anyway, and re-rendering on every trim would replace the whole
      // buffer on every busy poll once the buffer is full. The re-render
      // trigger is the visible-line cap, decided before this poll's
      // appends (pure tickPlan in logDedup.ts).
      if (tickPlan(this.bufferedLines, MAX_BUFFER_LINES) === "render") {
        // The channel text outgrew the cap: rewrite it from the buffer.
        // The gap marker travels inside the buffer and keeps its position.
        this.render();
      } else {
        // Append path -- under a filter too: the buffer and the channel
        // stay in step because every push above is mirrored here through
        // matches(), so no full-buffer replace (and no scroll yank) on new
        // entries.
        for (const item of added) {
          if (item === GAP_MARK) {
            this.channel.appendLine(gapMarker());
            this.bufferedLines += 1;
            continue;
          }
          if (!this.matches(item)) continue;
          this.channel.appendLine(formatLogEntry(item));
          this.bufferedLines += 1;
        }
      }
    } catch {
      // Transient fetch failure: daemon-loss detection belongs to the SSE
      // watchdog, so a dead poll here just skips a tick.
    } finally {
      this.ticking = false;
      this.timer = shouldPoll(this.connected, this.everShown)
        ? setTimeout(() => {
            this.timer = undefined;
            void this.tick();
          }, nextDelayMs(this.idleTicks))
        : undefined;
    }
  }
}

/** Quick-pick for the view-title "Set Log Level..." command. */
export async function askLogLevel(current: LogLevel): Promise<LogLevel | undefined> {
  const t = vscode.l10n.t;
  const pick = await vscode.window.showQuickPick(
    LEVEL_PICKS.map((p) => ({
      level: p.level,
      label: p.label(),
      description: p.level === current ? t("current") : undefined,
    })),
    { title: t("Portato Logs: minimum level"), placeHolder: t("Show entries at or above") },
  );
  return pick?.level;
}
