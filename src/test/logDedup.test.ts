import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LogEntry } from "../types";
import { formatLogEntry, levelRank, LogTail, logKey, parseLogTime } from "../logDedup";

function entry(
  time: string,
  msg: string,
  opts: Partial<Pick<LogEntry, "level" | "tuber" | "attrs">> = {},
): LogEntry {
  return { time, level: opts.level ?? "INFO", msg, tuber: opts.tuber, attrs: opts.attrs };
}

describe("LogTail", () => {
  it("emits everything on the first fetch, without a gap", () => {
    const tail = new LogTail();
    const ring = [entry("t1", "a"), entry("t2", "b")];
    const d = tail.diff(ring);
    assert.deepEqual(d.entries, ring);
    assert.equal(d.gap, false);
  });

  it("emits only the tail after the anchor on a normal append", () => {
    const tail = new LogTail();
    tail.diff([entry("t1", "a"), entry("t2", "b")]);
    const d = tail.diff([entry("t1", "a"), entry("t2", "b"), entry("t3", "c")]);
    assert.deepEqual(d.entries, [entry("t3", "c")]);
    assert.equal(d.gap, false);
  });

  it("handles duplicate keys by anchoring on the newest occurrence", () => {
    const tail = new LogTail();
    tail.diff([entry("t1", "same")]);
    const d = tail.diff([entry("t1", "same"), entry("t1", "same")]);
    // The second identical entry is genuinely new but indistinguishable
    // from the anchor: skipping it is the accepted dedupe trade-off.
    assert.deepEqual(d.entries, []);
    assert.equal(d.gap, false);
  });

  it("finds the anchor after the ring rotated older entries out", () => {
    const tail = new LogTail();
    tail.diff([entry("t1", "a"), entry("t2", "b"), entry("t3", "c")]);
    const d = tail.diff([entry("t3", "c"), entry("t4", "d")]);
    assert.deepEqual(d.entries, [entry("t4", "d")]);
    assert.equal(d.gap, false);
  });

  it("falls back to parsed instants, not strings, when the anchor is gone", () => {
    const tail = new LogTail();
    tail.diff([entry("2026-10-24T12:00:00.1Z", "a")]);
    // RFC3339Nano trims trailing zeros, so string order is not time order:
    // ".12Z" < ".1Z" lexicographically although .12s is NEWER than .1s.
    const d = tail.diff([
      entry("2026-10-24T12:00:00.05Z", "older"),
      entry("2026-10-24T12:00:00.12Z", "fresh"),
    ]);
    assert.deepEqual(d.entries, [entry("2026-10-24T12:00:00.12Z", "fresh")]);
    assert.equal(d.gap, true);
  });

  it("keeps a newer same-second entry whose fraction is lexicographically smaller", () => {
    const tail = new LogTail();
    // Anchor: whole second, no fraction. Fetched: same second + .5s.
    tail.diff([entry("2026-10-24T12:00:05Z", "a")]);
    const d = tail.diff([entry("2026-10-24T12:00:05.5Z", "b")]);
    assert.deepEqual(d.entries, [entry("2026-10-24T12:00:05.5Z", "b")]);
    assert.equal(d.gap, true);
  });

  it("anchors again after a gap, without re-dumping", () => {
    const tail = new LogTail();
    tail.diff([entry("t5", "a")]);
    tail.diff([entry("t6", "fresh")]);
    const d = tail.diff([entry("t6", "fresh"), entry("t7", "next")]);
    assert.deepEqual(d.entries, [entry("t7", "next")]);
    assert.equal(d.gap, false);
  });

  it("returns nothing on an empty fetch and keeps the anchor", () => {
    const tail = new LogTail();
    tail.diff([entry("t1", "a")]);
    const d = tail.diff([]);
    assert.deepEqual(d.entries, []);
    assert.equal(d.gap, false);
    const next = tail.diff([entry("t1", "a"), entry("t2", "b")]);
    assert.deepEqual(next.entries, [entry("t2", "b")]);
  });

  it("reset makes the next fetch a fresh first fetch", () => {
    const tail = new LogTail();
    tail.diff([entry("t1", "a")]);
    tail.reset();
    const d = tail.diff([entry("t1", "a"), entry("t2", "b")]);
    assert.deepEqual(d.entries, [entry("t1", "a"), entry("t2", "b")]);
    assert.equal(d.gap, false);
  });
});

describe("logKey", () => {
  it("distinguishes fields that concatenate ambiguously", () => {
    const a = entry("t", "2x", { level: "INFO" });
    const b = entry("t", "x", { level: "INFO+2" });
    assert.notEqual(logKey(a), logKey(b));
  });

  it("ignores undefined vs missing optional fields", () => {
    assert.equal(
      logKey(entry("t", "m", { tuber: undefined })),
      logKey({ time: "t", level: "INFO", msg: "m" }),
    );
  });
});

describe("parseLogTime", () => {
  it("orders Z-suffixed fractions of different lengths by instant", () => {
    const a = parseLogTime("2026-10-24T12:00:00.1Z");
    const b = parseLogTime("2026-10-24T12:00:00.12Z");
    assert.ok(a !== null && b !== null && a < b);
  });

  it("treats a missing fraction as .000", () => {
    const whole = parseLogTime("2026-10-24T12:00:05Z");
    const frac = parseLogTime("2026-10-24T12:00:05.5Z");
    assert.ok(whole !== null && frac !== null && whole < frac);
  });

  it("normalises numeric offsets against UTC", () => {
    const utc = parseLogTime("2026-10-24T12:00:00+00:00");
    const plus3 = parseLogTime("2026-10-24T15:00:00+03:00");
    const minus3compact = parseLogTime("2026-10-24T09:00:00-0300");
    assert.ok(utc !== null && plus3 !== null && minus3compact !== null);
    assert.equal(utc, plus3);
    assert.equal(utc, minus3compact);
  });

  it("accepts nanosecond fractions", () => {
    const t = parseLogTime("2026-10-24T12:00:00.123456789Z");
    assert.ok(t !== null && t > parseLogTime("2026-10-24T12:00:00.123Z")!);
  });

  it("returns null for shapes outside RFC3339Nano", () => {
    assert.equal(parseLogTime("t6"), null);
    assert.equal(parseLogTime("2026-10-24 12:00:00"), null);
    assert.equal(parseLogTime(""), null);
  });
});

describe("levelRank", () => {
  it("orders the standard levels like slog", () => {
    assert.ok(levelRank("DEBUG")! < levelRank("INFO")!);
    assert.ok(levelRank("INFO")! < levelRank("WARN")!);
    assert.ok(levelRank("WARN")! < levelRank("ERROR")!);
  });

  it("treats +N as more verbose within the band", () => {
    assert.ok(levelRank("INFO+2")! < levelRank("WARN")!);
    assert.ok(levelRank("INFO+2")! > levelRank("INFO")!);
  });

  it("returns null for unknown levels", () => {
    assert.equal(levelRank("TRACE"), null);
    assert.equal(levelRank("garbage"), null);
  });
});

describe("formatLogEntry", () => {
  it("renders time, level, tuber, message and attributes", () => {
    const line = formatLogEntry(
      entry("2026-10-24T10:00:00Z", "dial failed", {
        level: "ERROR",
        tuber: "web",
        attrs: "error=timeout",
      }),
    );
    assert.equal(
      line,
      "2026-10-24T10:00:00Z [ERROR] [web] dial failed -- error=timeout",
    );
  });

  it("omits the tuber and attrs segments when absent", () => {
    assert.equal(formatLogEntry(entry("t", "m")), "t [INFO] m");
  });
});
