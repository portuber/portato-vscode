import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attentionCount, contextSend, renderBar } from "../statusBar";
import type { TuberStatus } from "../types";

const S = (over: Partial<TuberStatus>): TuberStatus => ({
  name: "t",
  type: "local",
  local: "l",
  remote: "r",
  state: "off",
  connected_at: "0001-01-01T00:00:00Z",
  ...over,
});

describe("attentionCount", () => {
  it("an error tuber counts", () => {
    assert.equal(attentionCount([S({ state: "error", error: "dial refused" })]), 1);
  });

  it("a pending prompt in connecting counts", () => {
    assert.equal(
      attentionCount([S({ state: "connecting", pending_passphrase: "/id_ed25519" })]),
      1,
    );
  });

  it("error + pending host key on the same tuber counts ONCE", () => {
    assert.equal(
      attentionCount([S({ state: "error", pending_host: "h" })]),
      1,
    );
  });

  it("connected/off tubers and an empty list count zero", () => {
    assert.equal(
      attentionCount([
        S({ name: "a", state: "connected" }),
        S({ name: "b", state: "off" }),
      ]),
      0,
    );
    assert.equal(attentionCount([]), 0);
  });
});

describe("renderBar", () => {
  it("disconnected: no socket needed, points at starting the daemon", () => {
    assert.deepEqual(renderBar("disconnected", undefined, 0, 0), {
      text: "$(debug-disconnect) Portato: daemon not running",
      tooltip: "Start the Portato daemon to manage tunnels",
      attention: 0,
    });
  });

  it("connecting: spinner and no socket hint", () => {
    const r = renderBar("connecting", "/tmp/portato.sock", 0, 0);
    assert.equal(r.text, "$(sync~spin) Portato: connecting...");
    assert.equal(r.tooltip, "Discovering the Portato daemon...");
  });

  it("reconnecting: spinner with the socket as tooltip, fallback without it", () => {
    assert.equal(
      renderBar("reconnecting", "/tmp/portato.sock", 0, 0).tooltip,
      "/tmp/portato.sock",
    );
    assert.equal(
      renderBar("reconnecting", undefined, 0, 0).tooltip,
      "Reconnecting to the Portato daemon...",
    );
  });

  it("live: reports the connected count, socket as tooltip", () => {
    assert.equal(
      renderBar("live", "/tmp/portato.sock", 3, 0).text,
      "$(plug) Portato: 3 connected",
    );
    assert.equal(renderBar("live", "/tmp/portato.sock", 3, 0).tooltip, "/tmp/portato.sock");
  });

  it("live: attention adds a tooltip line, an alert suffix and the tally", () => {
    const r = renderBar("live", "/tmp/portato.sock", 3, 2);
    assert.equal(r.text, "$(plug) Portato: 3 connected $(alert) 2");
    assert.equal(
      r.tooltip,
      "/tmp/portato.sock\n2 tunnels need attention (error or pending prompt)",
    );
    assert.equal(r.attention, 2);
  });

  it("live without a socket still renders the attention line", () => {
    const r = renderBar("live", undefined, 1, 1);
    assert.equal(r.text, "$(plug) Portato: 1 connected $(alert) 1");
    assert.equal(r.tooltip, "1 tunnels need attention (error or pending prompt)");
  });

  it("zero attention never alerts in any state", () => {
    for (const state of ["disconnected", "connecting", "reconnecting", "live", "rejected"] as const) {
      assert.equal(renderBar(state, "/tmp/s", 0, 0).attention, 0, state);
      assert.ok(!renderBar(state, "/tmp/s", 0, 0).text.includes("$(alert)"), state);
    }
  });

  it("attention carries through non-live states too (controller clears the tally on disconnect)", () => {
    const r = renderBar("reconnecting", "/tmp/s", 0, 3);
    assert.equal(r.attention, 3);
    assert.ok(r.text.endsWith("$(alert) 3"));
  });

  it("rejected: alive-but-rejecting, points at the token, never at Start", () => {
    assert.deepEqual(renderBar("rejected", undefined, 0, 0), {
      text: "$(key) Portato: credentials rejected",
      tooltip:
        "The daemon is running but rejects the extension's IPC token -- check portato.socketPath or restart the daemon",
      attention: 0,
    });
  });

  it("renders deterministically for repeated identical inputs", () => {
    const a = renderBar("live", "/tmp/portato.sock", 1, 1);
    const b = renderBar("live", "/tmp/portato.sock", 1, 1);
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
