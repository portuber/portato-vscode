import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AskedPrompts, promptKey } from "../promptKeys";
import { pendingPrompt, type TuberStatus } from "../types";

// Regression tests for the review findings on prompt detection/dedupe:
//   - host-key pending survives error/reconnecting (daemon keeps pending_host
//     through the backoff between redials)
//   - the host-key dedupe key must not flap across the redial window
//     (clearPendingHost at dial start, back on failure)
//   - a wrong answer re-asks via the attempts counter; a dismissed one does
//     not (tree action re-opens it instead)

const base: TuberStatus = {
  name: "web",
  type: "local",
  local: "localhost:8080",
  remote: "localhost:80",
  state: "connecting",
  connected_at: "0001-01-01T00:00:00Z",
};

describe("pendingPrompt", () => {
  it("host key: surfaces in error state (daemon keeps pending_host there)", () => {
    const s: TuberStatus = {
      ...base,
      state: "error",
      error: "ssh: host key not trusted",
      pending_host: "example.com:22",
      pending_fingerprint: "SHA256:abc",
    };
    assert.deepStrictEqual(pendingPrompt(s), {
      kind: "hostkey",
      detail: "example.com:22",
      fingerprint: "SHA256:abc",
      attempts: 0,
    });
  });

  it("host key: surfaces in reconnecting too", () => {
    const s: TuberStatus = {
      ...base,
      state: "reconnecting",
      pending_host: "example.com:22",
    };
    assert.strictEqual(pendingPrompt(s)?.kind, "hostkey");
  });

  it("passphrase: only while the dial blocks (state connecting)", () => {
    const blocked: TuberStatus = {
      ...base,
      state: "connecting",
      pending_passphrase: "~/.ssh/id_ed25519",
      passphrase_attempts: 1,
    };
    assert.strictEqual(pendingPrompt(blocked)?.kind, "passphrase");
    assert.strictEqual(pendingPrompt(blocked)?.attempts, 1);
    // Dial failed: the daemon clears the flag before setStateErr.
    const failed: TuberStatus = { ...blocked, state: "error", error: "denied" };
    assert.strictEqual(pendingPrompt(failed), null);
  });

  it("no pending flags -> null in any state", () => {
    assert.strictEqual(pendingPrompt({ ...base, state: "connecting" }), null);
    assert.strictEqual(pendingPrompt({ ...base, state: "connected" }), null);
  });
});

describe("promptKey / AskedPrompts", () => {
  it("host key keys by fingerprint, not attempts", () => {
    const err: TuberStatus = {
      ...base,
      state: "error",
      pending_host: "example.com:22",
      pending_fingerprint: "SHA256:abc",
    };
    assert.strictEqual(promptKey(err)?.key, "web:hostkey:SHA256:abc");
  });

  it("passphrase key carries the attempts counter", () => {
    const s: TuberStatus = {
      ...base,
      pending_passphrase: "~/.ssh/id_ed25519",
      passphrase_attempts: 2,
    };
    assert.strictEqual(promptKey(s)?.key, "web:passphrase:2");
  });

  it("does not flap across the redial window (error -> connecting -> error)", () => {
    const asked = new AskedPrompts();
    const err: TuberStatus = {
      ...base,
      state: "error",
      pending_host: "example.com:22",
      pending_fingerprint: "SHA256:abc",
    };
    const dialing: TuberStatus = { ...base, state: "connecting", error: "x" };

    const k = promptKey(err)!.key;
    asked.add(k, { name: "web", kind: "hostkey" });

    // Dial restarts: pending_host cleared at dial start...
    asked.prune([dialing]);
    assert.ok(asked.has(k), "redial window must keep the host-key key");
    // ...and comes back with the failure.
    asked.prune([err]);
    assert.ok(asked.has(k));

    // Resolved states prune it.
    asked.prune([{ ...base, state: "connected" }]);
    assert.ok(!asked.has(k));

    asked.add(k, { name: "web", kind: "hostkey" });
    asked.prune([{ ...base, state: "off" }]);
    assert.ok(!asked.has(k));

    asked.add(k, { name: "web", kind: "hostkey" });
    asked.prune([]); // tuber vanished
    assert.ok(!asked.has(k));
  });

  it("passphrase key is pruned as soon as the exact pending state is gone", () => {
    const asked = new AskedPrompts();
    const s: TuberStatus = {
      ...base,
      pending_passphrase: "~/.ssh/id_ed25519",
      passphrase_attempts: 0,
    };
    const k = promptKey(s)!.key;
    asked.add(k, { name: "web", kind: "passphrase" });

    asked.prune([{ ...base, state: "error", error: "denied" }]);
    assert.ok(!asked.has(k), "dial failure clears the flag -> key pruned");

    // A wrong answer bumps attempts -> a NEW key re-asks.
    const bumped: TuberStatus = { ...s, passphrase_attempts: 1 };
    assert.notStrictEqual(promptKey(bumped)?.key, k);
  });

  it("host keys of different tunnels do not collide", () => {
    const asked = new AskedPrompts();
    const a: TuberStatus = { ...base, name: "a", state: "error", pending_host: "h:1", pending_fingerprint: "fp" };
    const b: TuberStatus = { ...base, name: "b", state: "error", pending_host: "h:1", pending_fingerprint: "fp" };
    asked.add(promptKey(a)!.key, { name: "a", kind: "hostkey" });
    asked.add(promptKey(b)!.key, { name: "b", kind: "hostkey" });
    assert.strictEqual(asked.size(), 2);
    asked.prune([{ ...a, state: "connected" }]); // a resolved, b still error+pending? b absent -> pruned too
    assert.strictEqual(asked.size(), 0);
  });
});
