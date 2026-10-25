import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveViewState } from "../viewState";

const facts = (over: Partial<Parameters<typeof deriveViewState>[0]> = {}) => ({
  binaryAvailable: undefined,
  daemonUp: undefined,
  authRejected: false,
  tuberCount: undefined,
  ...over,
});

describe("deriveViewState", () => {
  it("loading before the first connect attempt, whatever the binary check", () => {
    assert.equal(deriveViewState(facts()), "loading");
    assert.equal(deriveViewState(facts({ binaryAvailable: false })), "loading");
    assert.equal(deriveViewState(facts({ binaryAvailable: true })), "loading");
  });

  it("stopped when the daemon is down and the binary check is pending/true", () => {
    assert.equal(
      deriveViewState(facts({ daemonUp: false })),
      "stopped",
    );
    assert.equal(
      deriveViewState(facts({ daemonUp: false, binaryAvailable: true })),
      "stopped",
    );
  });

  it("noBinary only once the async check has actually answered false", () => {
    assert.equal(
      deriveViewState(facts({ daemonUp: false, binaryAvailable: false })),
      "noBinary",
    );
  });

  it("rejected wins over everything after the first attempt (daemon alive at 401)", () => {
    assert.equal(
      deriveViewState(facts({ daemonUp: true, authRejected: true, tuberCount: 3 })),
      "rejected",
    );
    // daemonUp=false with authRejected cannot happen in practice, but the
    // 401 answer proves liveness, so rejected stays honest anyway.
    assert.equal(
      deriveViewState(facts({ daemonUp: false, authRejected: true })),
      "rejected",
    );
  });

  it("daemon up without fetched statuses stays loading (no empty flash)", () => {
    assert.equal(deriveViewState(facts({ daemonUp: true })), "loading");
  });

  it("empty vs ok by fetched tuber count", () => {
    assert.equal(
      deriveViewState(facts({ daemonUp: true, tuberCount: 0 })),
      "empty",
    );
    assert.equal(
      deriveViewState(facts({ daemonUp: true, tuberCount: 2 })),
      "ok",
    );
  });
});
