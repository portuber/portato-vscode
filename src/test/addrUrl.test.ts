import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  browserUrl,
  localAddress,
  normalizeHost,
  resolvedSocks5User,
  socksUrl,
  splitHostPort,
} from "../addrUrl";
import type { TuberStatus } from "../types";

const S = (over: Partial<TuberStatus>): TuberStatus => ({
  name: "t",
  type: "local",
  local: "127.0.0.1:8080",
  remote: "10.0.0.1:80",
  state: "off",
  connected_at: "0001-01-01T00:00:00Z",
  ...over,
});

describe("splitHostPort", () => {
  it("splits host:port at the last colon", () => {
    assert.deepEqual(splitHostPort("127.0.0.1:8080"), { host: "127.0.0.1", port: "8080" });
  });

  it("keeps bracketed IPv6 hosts intact", () => {
    assert.deepEqual(splitHostPort("[::1]:8080"), { host: "[::1]", port: "8080" });
  });

  it("an empty host is valid (all-interfaces listen form)", () => {
    assert.deepEqual(splitHostPort(":8080"), { host: "", port: "8080" });
  });

  it("portless and trailing-colon forms are undefined", () => {
    assert.equal(splitHostPort("127.0.0.1"), undefined);
    assert.equal(splitHostPort("127.0.0.1:"), undefined);
    assert.equal(splitHostPort("no-colon-here"), undefined);
  });
});

describe("normalizeHost", () => {
  it("wildcard binds become the loopback", () => {
    assert.equal(normalizeHost(""), "127.0.0.1");
    assert.equal(normalizeHost("0.0.0.0"), "127.0.0.1");
    assert.equal(normalizeHost("::"), "127.0.0.1");
    assert.equal(normalizeHost("[::]"), "127.0.0.1");
  });

  it("explicit hosts pass through", () => {
    assert.equal(normalizeHost("127.0.0.1"), "127.0.0.1");
    assert.equal(normalizeHost("192.168.1.10"), "192.168.1.10");
    assert.equal(normalizeHost("[::1]"), "[::1]");
  });
});

describe("localAddress", () => {
  it("normalizes wildcard binds", () => {
    assert.equal(localAddress(S({ local: "0.0.0.0:6379" })), "127.0.0.1:6379");
    assert.equal(localAddress(S({ local: ":6379" })), "127.0.0.1:6379");
  });

  it("passes concrete hosts through; malformed locals are undefined", () => {
    assert.equal(localAddress(S({ local: "127.0.0.1:6379" })), "127.0.0.1:6379");
    assert.equal(localAddress(S({ local: "oops" })), undefined);
  });
});

describe("browserUrl", () => {
  it("local forwards become http URLs with a normalized host", () => {
    assert.equal(browserUrl(S({ type: "local", local: "0.0.0.0:3000" })), "http://127.0.0.1:3000");
  });

  it("remote and dynamic tunnels have no browser URL", () => {
    assert.equal(browserUrl(S({ type: "remote" })), undefined);
    assert.equal(browserUrl(S({ type: "dynamic" })), undefined);
  });
});

describe("resolvedSocks5User", () => {
  it("the tuber's own non-blank user wins over the default", () => {
    assert.equal(resolvedSocks5User("tuberuser", "du"), "tuberuser");
  });

  it("a whitespace-only tuber value falls back to the default", () => {
    assert.equal(resolvedSocks5User("   ", "du"), "du");
  });

  it("a tuber missing from the config uses the default; both empty means no user", () => {
    assert.equal(resolvedSocks5User(undefined, "du"), "du");
    assert.equal(resolvedSocks5User(undefined, undefined), "");
    assert.equal(resolvedSocks5User("", ""), "");
  });
});

describe("socksUrl", () => {
  it("dynamic tunnels build a socks5 URL; the user is prefixed when set", () => {
    assert.equal(
      socksUrl(S({ type: "dynamic", local: "127.0.0.1:1080" }), ""),
      "socks5://127.0.0.1:1080",
    );
    assert.equal(
      socksUrl(S({ type: "dynamic", local: "127.0.0.1:1080" }), "alice"),
      "socks5://alice@127.0.0.1:1080",
    );
  });

  it("the username is percent-encoded so delimiters cannot forge the URL", () => {
    assert.equal(
      socksUrl(S({ type: "dynamic", local: "127.0.0.1:1080" }), "a@b:c d"),
      "socks5://a%40b%3Ac%20d@127.0.0.1:1080",
    );
  });

  it("non-dynamic tunnels have no SOCKS URL; no password can appear by construction", () => {
    assert.equal(socksUrl(S({ type: "local" }), "alice"), undefined);
    assert.equal(socksUrl(S({ type: "remote" }), ""), undefined);
    // socksUrl takes no password argument at all -- structural guarantee.
    assert.equal(socksUrl.length, 2);
  });
});
