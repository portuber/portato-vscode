import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contextSend, renderBar } from "../statusBar";

describe("renderBar", () => {
  it("disconnected: no socket needed, points at starting the daemon", () => {
    assert.deepEqual(renderBar("disconnected", undefined, 0), {
      text: "$(debug-disconnect) Portato: daemon not running",
      tooltip: "Start the Portato daemon to manage tunnels",
    });
  });

  it("connecting: spinner and no socket hint", () => {
    const r = renderBar("connecting", "/tmp/portato.sock", 0);
    assert.equal(r.text, "$(sync~spin) Portato: connecting...");
    assert.equal(r.tooltip, "Discovering the Portato daemon...");
  });

  it("reconnecting: spinner with the socket as tooltip, fallback without it", () => {
    assert.equal(
      renderBar("reconnecting", "/tmp/portato.sock", 0).tooltip,
      "/tmp/portato.sock",
    );
    assert.equal(
      renderBar("reconnecting", undefined, 0).tooltip,
      "Reconnecting to the Portato daemon...",
    );
  });

  it("live: reports the connected count, socket as tooltip", () => {
    assert.equal(renderBar("live", "/tmp/portato.sock", 3).text, "$(plug) Portato: 3 connected");
    assert.equal(renderBar("live", "/tmp/portato.sock", 3).tooltip, "/tmp/portato.sock");
  });

  it("rejected: alive-but-rejecting, points at the token, never at Start", () => {
    assert.deepEqual(renderBar("rejected", undefined, 0), {
      text: "$(key) Portato: credentials rejected",
      tooltip:
        "The daemon is running but rejects the extension's IPC token -- check portato.socketPath or restart the daemon",
    });
  });

  it("renders deterministically for repeated identical inputs", () => {
    const a = renderBar("live", "/tmp/portato.sock", 1);
    const b = renderBar("live", "/tmp/portato.sock", 1);
    assert.deepEqual(a, b);
  });
});

describe("contextSend", () => {
  it("connecting never sends and never caches (not even its true value)", () => {
    assert.equal(contextSend("connecting", undefined), undefined);
    assert.equal(contextSend("connecting", false), undefined);
  });

  it("disconnected sends false once, then dedups", () => {
    assert.equal(contextSend("disconnected", undefined), false);
    assert.equal(contextSend("disconnected", false), undefined);
  });

  it("live/reconnecting send true once, then dedup", () => {
    assert.equal(contextSend("live", false), true);
    assert.equal(contextSend("reconnecting", true), undefined);
    assert.equal(contextSend("live", true), undefined);
  });

  it("rejected counts as running: Stop stays, Start never appears", () => {
    // daemonRunning=true keeps the view title on Stop; a Start button there
    // would spawn a second daemon that only loses the single-instance flock.
    assert.equal(contextSend("rejected", undefined), true);
    assert.equal(contextSend("rejected", false), true);
    assert.equal(contextSend("rejected", true), undefined);
  });

  it("connecting between sends does not swallow the transition", () => {
    // disconnected -> connecting -> live must still send true.
    let sent = contextSend("disconnected", undefined);
    assert.equal(sent, false);
    sent = contextSend("connecting", sent);
    assert.equal(sent, undefined);
    assert.equal(contextSend("live", false), true);
  });
});
