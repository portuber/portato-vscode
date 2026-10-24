// Incremental diff of the daemon's GET /logs ring against the entries
// already shown. Kept free of vscode so it is unit-testable.
//
// The ring (internal/log/ring.go) holds at most 2000 entries in
// chronological order and offers no cursor, so the client anchors on the
// last EMITTED entry: a ring is append-only, which makes scanning backwards
// for the anchor safe -- the newest occurrence is the one we emitted. When
// the anchor has been evicted (ring rotated past it or the daemon
// restarted) the fallback is the timestamp: everything newer than the last
// seen entry, plus a gap flag so the view can say entries were skipped.

import type { LogEntry } from "./types";

export function logKey(e: LogEntry): string {
  // JSON-serialized: the fields concatenate ambiguously with a plain join
  // (e.g. level "INFO" + msg "2..." vs level "INFO+2" + msg "...").
  return JSON.stringify([e.time, e.level, e.tuber ?? "", e.msg, e.attrs ?? ""]);
}

export interface LogDiff {
  /** Entries to emit, in ring order. */
  readonly entries: LogEntry[];
  /**
   * The anchor fell out of the ring: `entries` is the timestamp fallback
   * and skipped entries are possible (but not re-dumped).
   */
  readonly gap: boolean;
}

/**
 * Parse an RFC3339 timestamp as Go's time.Time marshals it (RFC3339Nano:
 * trailing-zero-trimmed fraction, Z or numeric offset). Date.parse is not
 * enough: V8 only reliably accepts 3 fraction digits, and lexicographic
 * string order is NOT time order (".1Z" > ".12Z"). Returns null on a shape
 * we do not recognise; callers fall back to string comparison there.
 */
const LOG_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/;

export function parseLogTime(time: string): number | null {
  const m = LOG_TIME_RE.exec(time);
  if (!m) return null;
  const y = m[1];
  const mo = m[2];
  const d = m[3];
  const h = m[4];
  const mi = m[5];
  const s = m[6];
  const frac = m[7];
  const zone = m[8];
  if (!y || !mo || !d || !h || !mi || !s || !zone) return null;
  let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (frac) {
    // Pad/truncate to nanoseconds, then convert to milliseconds.
    t += parseInt(frac.padEnd(9, "0").slice(0, 9), 10) / 1e6;
  }
  if (zone !== "Z") {
    const digits = zone.replace(":", "");
    const sign = digits.startsWith("-") ? -1 : 1;
    t -= sign * (+digits.slice(1, 3) * 3600_000 + +digits.slice(3, 5) * 60_000);
  }
  return t;
}

export class LogTail {
  private lastKey: string | null = null;
  private lastTime = "";

  /** Forget the anchor (a different daemon's socket took over). */
  reset(): void {
    this.lastKey = null;
    this.lastTime = "";
  }

  diff(fetched: LogEntry[]): LogDiff {
    if (fetched.length === 0) return { entries: [], gap: false };
    if (this.lastKey === null) {
      this.adopt(fetched);
      return { entries: fetched, gap: false };
    }
    for (let i = fetched.length - 1; i >= 0; i--) {
      const e = fetched[i];
      if (e !== undefined && logKey(e) === this.lastKey) {
        const entries = fetched.slice(i + 1);
        this.adopt(fetched);
        return { entries, gap: false };
      }
    }
    // Anchor evicted: emit only what is newer than the last seen entry.
    // Compare parsed instants, not strings -- RFC3339Nano fractions and
    // zone offsets do not sort lexicographically (see parseLogTime).
    const last = parseLogTime(this.lastTime);
    const entries = fetched.filter((e) => {
      const t = parseLogTime(e.time);
      if (t === null || last === null) return e.time > this.lastTime;
      return t > last;
    });
    this.adopt(fetched);
    return { entries, gap: true };
  }

  private adopt(fetched: LogEntry[]): void {
    const last = fetched[fetched.length - 1];
    if (last === undefined) return; // callers only pass non-empty rings
    this.lastKey = logKey(last);
    this.lastTime = last.time;
  }
}

// Severity rank mirroring slog: DEBUG=-4, INFO=0, WARN=4, ERROR=8. A
// "+N"/"-N" suffix shifts within the band, so "INFO+2" (slog's verbose
// info) ranks below WARN. Unknown levels return null -- callers treat that
// as "always include" rather than guessing.
export function levelRank(level: string): number | null {
  const m = /^([A-Za-z]+)([+-]\d+)?$/.exec(level);
  const word = m?.[1];
  if (!m || word === undefined) return null;
  const base: Record<string, number> = { DEBUG: -4, INFO: 0, WARN: 4, ERROR: 8 };
  const b = base[word.toUpperCase()];
  if (b === undefined) return null;
  return b + (m[2] ? parseInt(m[2], 10) : 0);
}

// Line format aims at the built-in "log" language of the output channel:
// ISO timestamp, bracketed level, bracketed tuber, message, attributes.
export function formatLogEntry(e: LogEntry): string {
  const tuber = e.tuber ? ` [${e.tuber}]` : "";
  const attrs = e.attrs ? ` -- ${e.attrs}` : "";
  return `${e.time} [${e.level}]${tuber} ${e.msg}${attrs}`;
}
