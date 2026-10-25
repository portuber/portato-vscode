import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TuberStatus } from "../types";
import { acceptStillPending } from "../hostKeyVerify";

// D-3 regression: the accept-host POST must go out only when the pair the
// user saw in the TOFU modal is still the pair pending at the daemon.

function status(pending_host?: string, pending_fingerprint?: string): TuberStatus {
  return {
    name: "web",
    type: "local",
    local: "127.0.0.1:6379",
    remote: "127.0.0.1:6379",
    state: "connecting",
    connected_at: "0001-01-01T00:00:00Z",
    pending_host,
    pending_fingerprint,
  };
}

const SHOWN = { host: "example.com:22", fingerprint: "SHA256:aaa" };

describe("acceptStillPending", () => {
  it("match: same host and fingerprint may proceed", () => {
    assert.equal(acceptStillPending(SHOWN, status("example.com:22", "SHA256:aaa")), true);
  });

  it("host changed: abort", () => {
    assert.equal(acceptStillPending(SHOWN, status("evil.example:22", "SHA256:aaa")), false);
  });

  it("fingerprint changed on the same host: abort", () => {
    assert.equal(acceptStillPending(SHOWN, status("example.com:22", "SHA256:bbb")), false);
  });

  it("nothing pending anymore: abort", () => {
    assert.equal(acceptStillPending(SHOWN, status(undefined, undefined)), false);
  });

  it("tuber gone (undefined): abort", () => {
    assert.equal(acceptStillPending(SHOWN, undefined), false);
  });

  it("fingerprint absent on both sides counts as unchanged", () => {
    assert.equal(
      acceptStillPending({ host: "h:22", fingerprint: undefined }, status("h:22")),
      true,
    );
  });

  it("fingerprint appearing (or vanishing) counts as changed", () => {
    assert.equal(
      acceptStillPending({ host: "h:22", fingerprint: undefined }, status("h:22", "SHA256:x")),
      false,
    );
    assert.equal(
      acceptStillPending({ host: "h:22", fingerprint: "SHA256:x" }, status("h:22")),
      false,
    );
  });
});
