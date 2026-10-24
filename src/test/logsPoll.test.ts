import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKED_OFF_POLL_MS, BASE_POLL_MS, nextDelayMs, shouldPoll } from "../logsPoll";

describe("shouldPoll", () => {
  it("polls only when connected AND shown at least once", () => {
    assert.equal(shouldPoll(false, false), false);
    assert.equal(shouldPoll(true, false), false); // never opened: no fetches at all
    assert.equal(shouldPoll(false, true), false); // connection gone
    assert.equal(shouldPoll(true, true), true);
  });
});

describe("nextDelayMs", () => {
  it("keeps the base cadence while the ring is fresh", () => {
    assert.equal(nextDelayMs(0), BASE_POLL_MS);
    assert.equal(nextDelayMs(4), BASE_POLL_MS);
  });

  it("backs off after a run of fully quiet polls", () => {
    assert.equal(nextDelayMs(5), BACKED_OFF_POLL_MS);
    assert.equal(nextDelayMs(50), BACKED_OFF_POLL_MS);
  });
});
