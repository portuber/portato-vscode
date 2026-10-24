// Pure decoding for the daemon launch-log tail. Kept free of vscode (and of
// fs) so it is unit-testable under plain `node --test`.

/**
 * Decode the bytes read from the launch log into error-message text.
 * `handle.read` may return fewer bytes than requested (short read, or the
 * file shrank between stat and read) -- the unread tail of the buffer is
 * NUL bytes that must not leak into the message. A zero `bytesRead` yields "".
 */
export function decodeLaunchTail(buffer: Buffer, bytesRead: number): string {
  return buffer.subarray(0, Math.max(bytesRead, 0)).toString("utf8").trim();
}
