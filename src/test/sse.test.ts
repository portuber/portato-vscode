import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { SseStream, type SseDeps, type SseEvents } from "../sse";
import { sleep } from "./fakeDaemon";

// All timings are small-but-real: the class takes every delay as an option,
// so tests exercise the real timer paths without a long suite.

interface Harness {
  stream: SseStream;
  /** number of times deps.open() was called */
  openCalls: number;
  signals: number;
  transitions: boolean[];
  push(frame: string): void;
  failNextOpen(n?: number): void;
  endStream(): void;
}

function harness(opts: {
  watchdogMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  debounceMs?: number;
}): Harness {
  const transitions: boolean[] = [];
  const counters = { signals: 0 };
  let openCalls = 0;
  let failOpens = 0;
  let current: Readable | undefined; // the stream of the LAST open

  const deps: SseDeps = {
    open() {
      openCalls++;
      if (failOpens > 0) {
        failOpens--;
        return Promise.reject(new Error("connect refused"));
      }
      // Every reconnect gets a fresh connection, like the real client.
      current = new Readable({ read() {} });
      return Promise.resolve(current);
    },
  };
  const events: SseEvents = {
    onSignal() {
      counters.signals++;
    },
    onStreamChange(open) {
      transitions.push(open);
    },
  };
  const stream = new SseStream(deps, events, {
    watchdogMs: 200,
    initialBackoffMs: 40,
    maxBackoffMs: 160,
    debounceMs: 25,
    ...opts,
  });
  return {
    stream,
    transitions,
    get signals() {
      return counters.signals;
    },
    get openCalls() {
      return openCalls;
    },
    push(frame: string) {
      current?.push(frame);
    },
    failNextOpen(n = 1) {
      failOpens = n;
    },
    endStream() {
      current?.push(null);
    },
  };
}

describe("SseStream", () => {
  it("first frame drives the initial load: one debounced signal", async () => {
    const h = harness({});
    h.stream.start();
    h.push("data: {}\n\n");
    await sleep(80);
    assert.equal(h.signals, 1);
    h.stream.stop();
  });

  it("bursts of frames coalesce into a single signal", async () => {
    const h = harness({});
    h.stream.start();
    h.push("data: {}\n\ndata: {}\n\n");
    await sleep(20);
    h.push("data: {}\n\n");
    await sleep(80);
    assert.equal(h.signals, 1);
    h.stream.stop();
  });

  it("heartbeat comments reset the watchdog and never signal", async () => {
    const h = harness({ watchdogMs: 120 });
    h.stream.start();
    for (let i = 0; i < 6; i++) {
      h.push(": heartbeat\n\n");
      await sleep(50);
    }
    assert.equal(h.signals, 0);
    assert.equal(h.openCalls, 1); // still on the first connection
    h.stream.stop();
  });

  it("frames split across chunks parse as one line", async () => {
    const h = harness({});
    h.stream.start();
    h.push("data: {");
    await sleep(10);
    h.push("}\n\n");
    await sleep(80);
    assert.equal(h.signals, 1);
    h.stream.stop();
  });

  it("server closing the stream triggers a reconnect", async () => {
    const h = harness({ initialBackoffMs: 50 });
    h.stream.start();
    await sleep(20);
    h.endStream();
    await sleep(20);
    assert.equal(h.openCalls, 1); // backoff has not elapsed yet
    await sleep(100); // 50 ms backoff passed
    assert.equal(h.openCalls, 2);
    h.stream.stop();
  });

  it("watchdog fires on silence: reconnect without any server close", async () => {
    const h = harness({ watchdogMs: 100, initialBackoffMs: 40 });
    h.stream.start(); // open #1, then total silence
    await sleep(60);
    assert.equal(h.openCalls, 1);
    await sleep(220); // 100ms watchdog + 40ms backoff (+ slack)
    assert.ok(h.openCalls >= 2, `opens=${h.openCalls}`);
    h.stream.stop();
  });

  it("consecutive open failures grow the backoff up to the cap", async () => {
    const h = harness({ initialBackoffMs: 40, maxBackoffMs: 120, watchdogMs: 10_000 });
    h.failNextOpen(2); // first two opens fail: delays 40, then 80
    const t0 = Date.now();
    h.stream.start();
    while (h.openCalls < 3 && Date.now() - t0 < 3000) await sleep(15);
    const elapsed = Date.now() - t0;
    assert.ok(h.openCalls >= 3, `opens=${h.openCalls}`);
    // grew: 40 + 80 = 120ms minimum for the third attempt
    assert.ok(elapsed >= 110, `elapsed=${elapsed}ms -- backoff did not grow`);
    h.stream.stop();
  });

  it("backoff resets after a successful reconnect", async () => {
    const h = harness({ initialBackoffMs: 50, maxBackoffMs: 200, watchdogMs: 10_000 });
    h.stream.start(); // open #1
    await sleep(20);
    h.endStream();
    await sleep(20);
    h.endStream(); // nothing to end yet; harmless
    await sleep(100); // open #2 after ~50 ms; its backoff reset to 50
    assert.ok(h.openCalls >= 2, `opens=${h.openCalls}`);
    const afterSecond = h.openCalls;
    h.endStream();
    await sleep(20);
    h.endStream();
    await sleep(100); // if backoff had grown to 100+, this window would miss it
    assert.ok(h.openCalls >= afterSecond + 1, `opens=${h.openCalls} after=${afterSecond}`);
    h.stream.stop();
  });

  it("stop() tears everything down: no signals, no reconnects", async () => {
    const h = harness({});
    h.stream.start();
    h.push("data: {}\n\n");
    await sleep(60);
    h.stream.stop();
    const callsAtStop = h.openCalls;
    const signalsAtStop = h.signals;
    h.push("data: {}\n\n");
    await sleep(400);
    assert.equal(h.openCalls, callsAtStop);
    assert.equal(h.signals, signalsAtStop);
  });

  it("stop() during a pending debounce does not wedge the next start()", async () => {
    const h = harness({});
    h.stream.start();
    h.push("data: {}\n\n");
    await sleep(5); // frame arrived, debounce (25ms) still pending
    h.stream.stop();
    await sleep(60); // debounce would have fired mid-stop
    assert.equal(h.signals, 0);
    h.stream.start();
    h.push("data: {}\n\n");
    await sleep(80);
    assert.equal(h.signals, 1);
    h.stream.stop();
  });

  it("stream-change transitions follow open/close", async () => {
    const h = harness({ initialBackoffMs: 40 });
    h.stream.start();
    await sleep(30);
    assert.deepEqual(h.transitions, [true]);
    h.endStream();
    await sleep(120);
    h.stream.stop();
    assert.deepEqual(h.transitions, [true, false, true, false]);
  });
});
