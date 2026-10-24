import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeLaunchTail } from "../launchLog";

// decodeLaunchTail: pure tail decoding for the daemon launch log. The
// launch-log reader passes the buffer AND bytesRead from handle.read; the
// unread tail is NUL bytes that must not leak into the error message.

describe("decodeLaunchTail", () => {
  it("decodes exactly the bytes read", () => {
    const buf = Buffer.from("daemon failed: boom\n", "utf8");
    assert.equal(decodeLaunchTail(buf, buf.length), "daemon failed: boom");
  });

  it("ignores the unread NUL tail of a short read", () => {
    const buf = Buffer.alloc(64);
    const text = "bind: address already in use";
    buf.set(Buffer.from(text, "utf8"), 0);
    assert.equal(decodeLaunchTail(buf, text.length), text);
  });

  it("a zero bytesRead (file shrank between stat and read) yields empty", () => {
    const buf = Buffer.from("stale", "utf8");
    assert.equal(decodeLaunchTail(buf, 0), "");
  });

  it("trims surrounding whitespace", () => {
    const buf = Buffer.from("\n  tail line  \n", "utf8");
    assert.equal(decodeLaunchTail(buf, buf.length), "tail line");
  });
});
