import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyVersion,
  compareVersions,
  MIN_DAEMON_VERSION,
} from "../daemonVersion";

describe("compareVersions", () => {
  it("compares numerically, not lexicographically", () => {
    assert.equal(compareVersions("1.9.0", "1.10.0"), -1);
    assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
  });

  it("equal triads compare 0, with or without a leading v", () => {
    assert.equal(compareVersions("1.11.0", "1.11.0"), 0);
    assert.equal(compareVersions("v1.11.0", "1.11.0"), 0);
  });

  it("orders by major, then minor, then patch", () => {
    assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
    assert.equal(compareVersions("1.11.0", "1.12.0"), -1);
    assert.equal(compareVersions("1.11.1", "1.11.0"), 1);
    assert.equal(compareVersions("1.11.0", "1.11.1"), -1);
  });
});

describe("classifyVersion", () => {
  it("MIN is 1.11.0 (the first daemon with the version field)", () => {
    assert.equal(MIN_DAEMON_VERSION, "1.11.0");
  });

  it("ok at and above MIN", () => {
    assert.equal(classifyVersion("1.11.0"), "ok");
    assert.equal(classifyVersion("v1.12.3"), "ok");
    assert.equal(classifyVersion("2.0.0"), "ok");
  });

  it("belowMin under MIN", () => {
    assert.equal(classifyVersion("1.10.9"), "belowMin");
    assert.equal(classifyVersion("1.2.0"), "belowMin");
    assert.equal(classifyVersion("1.10.99"), "belowMin");
  });

  it("unknown for a missing/empty field (a daemon older than 1.11.0)", () => {
    assert.equal(classifyVersion(undefined), "unknown");
    assert.equal(classifyVersion(""), "unknown");
  });

  it("unrecognized for a present-but-unparseable value (dev builds, pre-releases)", () => {
    // "dev" is the Go default (internal/daemon/server.go); pre-release
    // suffixes are builds we cannot vouch for. Neither is "old".
    assert.equal(classifyVersion("dev"), "unrecognized");
    assert.equal(classifyVersion("1.12.0-beta.1"), "unrecognized");
    assert.equal(classifyVersion("1.2"), "unrecognized");
  });
});
