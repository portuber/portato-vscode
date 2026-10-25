import assert from "node:assert/strict";
import { test } from "node:test";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import type { Readable } from "node:stream";
import { DechunkStream, dechunkBuffer, rawRequest, rawStream } from "../rawHttp";

async function collectStream(s: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of s) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

// Chunk sizes arrive with extensions ("1a;ext=1"), the terminating chunk is
// "0", and trailers may follow it -- the daemon's Go net/http only uses the
// plain forms, but the decoder stays lenient.

function dechunkSync(chunks: Buffer[]): Promise<Buffer> {
  const s = new DechunkStream();
  for (const c of chunks) s.write(c);
  s.end();
  return collectStream(s);
}

const b = (s: string): Buffer => Buffer.from(s, "latin1");

test("dechunkBuffer: single chunk", () => {
  assert.deepEqual(dechunkBuffer(b("5\r\nhello\r\n0\r\n\r\n")), b("hello"));
});

test("dechunkBuffer: several chunks with extensions and trailers", () => {
  const out = dechunkBuffer(b("3;ext=1\r\nabc\r\n2\r\nde\r\n0\r\nX-T: v\r\n\r\n"));
  assert.deepEqual(out, b("abcde"));
});

test("dechunkBuffer: empty payload", () => {
  assert.deepEqual(dechunkBuffer(b("0\r\n\r\n")), b(""));
});

test("dechunkBuffer: truncated size line throws", () => {
  // The "5" chunk is complete, but the stream ends where the terminating
  // chunk's size line should be.
  assert.throws(() => dechunkBuffer(b("5\r\nhello\r\n")), /size line/);
});

test("dechunkBuffer: truncated data throws", () => {
  assert.throws(() => dechunkBuffer(b("5\r\nhel")), /data/);
});

test("DechunkStream: byte-by-byte feeding", async () => {
  const input = b("a\r\n0123456789\r\n1\r\nZ\r\n0\r\n\r\n");
  const chunks: Buffer[] = [];
  for (const byte of input) chunks.push(Buffer.from([byte]));
  assert.deepEqual(await dechunkSync(chunks), b("0123456789Z"));
});

test("DechunkStream: size line split across writes", async () => {
  assert.deepEqual(
    await dechunkSync([b("d"), b("\r"), b("\nhello world!!\r"), b("\n0\r\n\r\n")]),
    b("hello world!!"),
  );
});

test("DechunkStream: EOF before the terminating chunk still ends", async () => {
  // Lenient by design: a server that closes mid-stream must not hang the
  // consumer; what arrived is delivered.
  const s = new DechunkStream();
  s.write(b("3\r\nabc\r\n"));
  s.end();
  assert.deepEqual(await collectStream(s), b("abc"));
});

test("DechunkStream: garbage size destroys the stream", async () => {
  const s = new DechunkStream();
  s.write(b("xyz\r\n"));
  await assert.rejects(() => collectStream(s), /bad chunk size/);
});

// Direct rawRequest/rawStream coverage against a real net.Server: the
// daemonClient tests exercise them only indirectly through fakeDaemon.

interface ServerHandle {
  socketPath: string;
  close(): Promise<void>;
}

async function withServer(
  onConnection: (sock: net.Socket) => void,
  fn: (h: ServerHandle) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "portato-rawhttp-"));
  const socketPath = path.join(dir, "s.sock");
  const live = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    live.add(sock);
    sock.on("close", () => live.delete(sock));
    onConnection(sock);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  try {
    await fn({
      socketPath,
      close: () => new Promise<void>((r) => server.close(() => r())),
    });
  } finally {
    for (const sock of live) sock.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

test("rawRequest: connection closed before response headers", async () => {
  await withServer(
    (sock) => void sock.end(),
    async ({ socketPath }) => {
      await assert.rejects(
        () =>
          rawRequest(socketPath, "GET", "/tubers", {}, undefined, 1000),
        /connection closed before response headers/,
      );
    },
  );
});

test("rawRequest: silent server hits the idle timeout, not a close race", async () => {
  await withServer(
    () => {},
    async ({ socketPath }) => {
      await assert.rejects(
        () => rawRequest(socketPath, "GET", "/tubers", {}, undefined, 150),
        /timed out/,
      );
    },
  );
});

test("rawRequest: body short of Content-Length rejects (clean close is not success)", async () => {
  await withServer(
    (sock) => {
      sock.on("data", () => {
        // Promises 10 bytes, delivers 5, then closes cleanly: a truncated
        // exchange that a plain EOF-based reader would resolve as success.
        sock.write(b("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort"));
        sock.end();
      });
    },
    async ({ socketPath }) => {
      await assert.rejects(
        () => rawRequest(socketPath, "GET", "/tubers", {}, undefined, 1000),
        /does not match Content-Length/,
      );
    },
  );
});

test("rawRequest: exact Content-Length body resolves", async () => {
  await withServer(
    (sock) => {
      sock.on("data", () => {
        const body = b('{"ok":true}');
        sock.write(
          b(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n`),
        );
        sock.end(body);
      });
    },
    async ({ socketPath }) => {
      const res = await rawRequest(socketPath, "GET", "/healthz", {}, undefined, 1000);
      assert.equal(res.status, 200);
      assert.equal(res.body.toString("utf8"), '{"ok":true}');
    },
  );
});

test("rawStream: chunked response whose first frame coalesced with the headers", async () => {
  await withServer(
    (sock) => {
      const chunk = (payload: string): string =>
        `${payload.length.toString(16)}\r\n${payload}\r\n`;
      // Headers and the first SSE frame in ONE write: the header reader
      // consumes them together and must feed the leftover into the
      // stream (regression: the first frames used to be dropped).
      sock.write(
        b(
          "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n" +
            chunk("data: {}\n\n"),
        ),
      );
      setTimeout(() => {
        sock.write(b(chunk(": heartbeat\n\n")));
        sock.end(b(chunk("")));
      }, 50);
    },
    async ({ socketPath }) => {
      const res = await rawStream(
        socketPath,
        "GET",
        "/events",
        {},
        1000,
      );
      assert.equal(res.status, 200);
      const text = (await collectStream(res.stream)).toString("latin1");
      assert.ok(text.startsWith("data: {}"), text);
      assert.ok(text.includes(": heartbeat"), text);
    },
  );
});
