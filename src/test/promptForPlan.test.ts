import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TuberStatus, TuberState } from "../types";
import { promptForPlan } from "../promptForPlan";

function status(
  name: string,
  state: TuberState,
  pending?: Partial<Pick<TuberStatus, "pending_host" | "pending_passphrase" | "pending_password">>,
): TuberStatus {
  return {
    name,
    type: "local",
    local: "127.0.0.1:1080",
    remote: "127.0.0.1:80",
    state,
    connected_at: "0001-01-01T00:00:00Z",
    ...pending,
  };
}

describe("promptForPlan", () => {
  it("offers a prompt whenever one is pending", () => {
    // Host key: pending regardless of state.
    assert.equal(
      promptForPlan(status("a", "error", { pending_host: "h:22" }), false),
      "prompt",
    );
    // Passphrase/password: pending only while the dial blocks.
    assert.equal(
      promptForPlan(status("a", "connecting", { pending_passphrase: "/k" }), true),
      "prompt",
    );
    assert.equal(
      promptForPlan(status("a", "connecting", { pending_password: "u@h:22" }), true),
      "prompt",
    );
  });

  it("reports the handshake window after an accepted host key", () => {
    // Accept -> connecting with pending_host cleared at dial start; the
    // remembered key keeps the prompt outstanding.
    assert.equal(
      promptForPlan(status("a", "connecting"), true),
      "handshake",
    );
  });

  it("does not extend the handshake window beyond connecting", () => {
    // A stale remembered flag (updatePendingHosts should have pruned it) or
    // a connecting tuber that never had a pending host: nothing to answer.
    assert.equal(promptForPlan(status("a", "error"), true), "none");
    assert.equal(promptForPlan(status("a", "connected"), true), "none");
    assert.equal(promptForPlan(status("a", "connecting"), false), "none");
    assert.equal(promptForPlan(status("a", "off"), false), "none");
  });
});
