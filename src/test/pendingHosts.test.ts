import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TuberStatus, TuberState } from "../types";
import { updatePendingHosts } from "../pendingHosts";

function status(
  name: string,
  state: TuberState,
  pendingHost = "",
): TuberStatus {
  return {
    name,
    type: "local",
    local: "127.0.0.1:1080",
    remote: "127.0.0.1:80",
    state,
    pending_host: pendingHost,
    connected_at: "0001-01-01T00:00:00Z",
  };
}

describe("updatePendingHosts", () => {
  it("remembers a tuber with a pending host key", () => {
    const map = new Map<string, string>();
    updatePendingHosts(map, [status("a", "error", "example.com:22")]);
    assert.equal(map.get("a"), "example.com:22");
  });

  it("keeps the entry through the connecting window of a redial", () => {
    const map = new Map<string, string>([["a", "example.com:22"]]);
    // Daemon clears pending_host at the start of every dial.
    updatePendingHosts(map, [status("a", "connecting")]);
    assert.equal(map.get("a"), "example.com:22");
    // ...and sets it again on the next TOFU rejection.
    updatePendingHosts(map, [status("a", "error", "example.com:22")]);
    assert.equal(map.get("a"), "example.com:22");
  });

  it("prunes after the key was accepted but the dial failed otherwise", () => {
    const map = new Map<string, string>([["a", "example.com:22"]]);
    // Accept -> connecting (entry kept) -> error without pending_host
    // (auth failure, host unreachable): the prompt will not come back.
    updatePendingHosts(map, [status("a", "connecting")]);
    updatePendingHosts(map, [status("a", "error")]);
    assert.equal(map.has("a"), false);
  });

  it("prunes when the tuber leaves the snapshot", () => {
    const map = new Map<string, string>([["a", "example.com:22"]]);
    updatePendingHosts(map, []);
    assert.equal(map.has("a"), false);
  });

  it("prunes on connected and off like any non-connecting state", () => {
    const map = new Map<string, string>([
      ["a", "h1"],
      ["b", "h2"],
    ]);
    updatePendingHosts(map, [status("a", "connected"), status("b", "off")]);
    assert.equal(map.size, 0);
  });
});
