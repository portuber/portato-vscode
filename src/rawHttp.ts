import * as net from "node:net";
import {
  PassThrough,
  Transform,
  type TransformCallback,
  type Readable,
} from "node:stream";

// Minimal HTTP/1.1 client over a raw net.Socket. This exists because VS Code
// patches node:http in the extension host (vscode-proxy-agent, on by default
// with http.proxySupport "override"): the patch resolves the request's dummy
// host through DNS and ignores custom agents, so http.request over a unix
// socket fails with getaddrinfo ENOTFOUND. Raw sockets are not intercepted.
//
// One connection per request with Connection: close -- the client volume is
// a poll loop plus one long-lived SSE stream, so pooling buys nothing.

export interface RawResponse {
  status: number;
  /** Header names lowercased. */
  headers: Record<string, string>;
  body: Buffer;
}

export interface RawStreamResponse {
  status: number;
  /** Header names lowercased. */
  headers: Record<string, string>;
  /** Response body after the headers, dechunked if chunked. */
  stream: Readable;
}

/** Sockets opened on behalf of a call, for a shared abort (client.destroy()). */
export type SocketTracker = Set<net.Socket>;

function track(sock: net.Socket, tracker?: SocketTracker): void {
  if (!tracker) return;
  tracker.add(sock);
  sock.on("close", () => tracker.delete(sock));
}

function writeRequest(
  sock: net.Socket,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
): void {
  const lines = [
    `${method} ${path} HTTP/1.1`,
    "Host: portato",
    "Connection: close",
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
  ];
  if (body !== undefined) lines.push(`Content-Length: ${body.length}`);
  sock.write(lines.join("\r\n") + "\r\n\r\n");
  if (body !== undefined) sock.write(body);
}

interface Head {
  status: number;
  headers: Record<string, string>;
  rest: Buffer;
}

function parseHead(head: Buffer): Head {
  const text = head.toString("latin1");
  const lines = text.split("\r\n");
  const m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0] ?? "");
  if (!m) throw new Error(`malformed status line: ${JSON.stringify(lines[0])}`);
  const status = Number(m[1]);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error(`malformed status code: ${JSON.stringify(lines[0])}`);
  }
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { status, headers, rest: Buffer.alloc(0) };
}

function headSplit(buf: Buffer): number {
  return buf.indexOf("\r\n\r\n");
}

/** Decode a fully buffered chunked body (regular responses only). */
export function dechunkBuffer(buf: Buffer): Buffer {
  const parts: Buffer[] = [];
  let off = 0;
  for (;;) {
    const i = buf.indexOf("\r\n", off);
    if (i < 0) throw new Error("chunked body truncated (size line)");
    const size = parseInt(
      buf.subarray(off, i).toString("ascii").split(";")[0]?.trim() ?? "",
      16,
    );
    if (!(size >= 0)) throw new Error(`bad chunk size: ${JSON.stringify(buf.subarray(off, i).toString("ascii"))}`);
    off = i + 2;
    if (size === 0) return Buffer.concat(parts);
    if (off + size > buf.length) throw new Error("chunked body truncated (data)");
    parts.push(Buffer.from(buf.subarray(off, off + size)));
    off += size + 2; // the CRLF after the chunk data
  }
}

/**
 * Incremental chunked-transfer decoder. Feeds it raw response body bytes,
 * it emits the payload; ends at the terminating "0" chunk (or at EOF, to
 * stay usable against servers that close instead of terminating cleanly).
 */
export class DechunkStream extends Transform {
  private buf: Buffer = Buffer.alloc(0);
  /** -1: read the size line; >0: bytes left of the current chunk; -2: skip CRLF. */
  private remaining = -1;
  private finished = false;

  override _transform(
    chunk: Buffer,
    _enc: BufferEncoding,
    cb: TransformCallback,
  ): void {
    if (this.finished) {
      cb();
      return;
    }
    this.buf = this.buf.length
      ? Buffer.concat([this.buf, chunk])
      : chunk;
    this.drain(cb);
  }

  override _final(cb: TransformCallback): void {
    // Lenient: a server that closes without the terminating chunk still
    // gets its data through (push(null) ends the consumer cleanly).
    if (!this.finished) this.push(null);
    cb();
  }

  private drain(cb: TransformCallback): void {
    for (;;) {
      if (this.remaining === -1) {
        const i = this.buf.indexOf("\r\n");
        if (i < 0) {
          cb();
          return;
        }
        const line = this.buf.subarray(0, i).toString("ascii");
        this.buf = this.buf.subarray(i + 2);
        const size = parseInt(line.split(";")[0]?.trim() ?? "", 16);
        if (!(size >= 0)) {
          const e = new Error(`bad chunk size: ${JSON.stringify(line)}`);
          this.destroy(e);
          cb(e);
          return;
        }
        if (size === 0) {
          this.finished = true;
          this.push(null);
          cb();
          return;
        }
        this.remaining = size;
      } else if (this.remaining > 0) {
        if (this.buf.length === 0) {
          cb();
          return;
        }
        const take = Math.min(this.remaining, this.buf.length);
        this.push(this.buf.subarray(0, take));
        this.buf = this.buf.subarray(take);
        this.remaining -= take;
        if (this.remaining === 0) this.remaining = -2;
      } else if (this.remaining === -2) {
        if (this.buf.length < 2) {
          cb();
          return;
        }
        this.buf = this.buf.subarray(2);
        this.remaining = -1;
      } else {
        cb();
        return;
      }
    }
  }
}

async function connect(
  socketPath: string,
  timeoutMs: number,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`connect to ${socketPath} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/**
 * Read the status line + headers; resolves after they are fully received.
 * `ownTimer` guards the headers phase with its own timeout; callers that
 * already keep a timer on the socket (rawRequest's idle timer) pass false
 * so the two cannot race over which rejection wins (destroy() schedules
 * "close" on nextTick, which beats this promise's own rejection).
 */
async function readHead(
  sock: net.Socket,
  timeoutMs: number,
  ownTimer = true,
): Promise<Head> {
  return new Promise<Head>((resolve, reject) => {
    let acc: Buffer = Buffer.alloc(0);
    const timer = ownTimer
      ? setTimeout(() => {
          sock.destroy();
          reject(new Error(`response headers timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      : undefined;
    const onData = (c: Buffer): void => {
      acc = acc.length ? Buffer.concat([acc, c]) : c;
      const idx = headSplit(acc);
      if (idx < 0) return;
      sock.removeListener("data", onData);
      if (timer) clearTimeout(timer);
      try {
        const head = parseHead(acc.subarray(0, idx));
        head.rest = acc.subarray(idx + 4);
        // Pause so no data event can slip past the caller between this
        // resolve and its continuation; the caller resumes or pipes.
        sock.pause();
        resolve(head);
      } catch (e) {
        sock.destroy();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    sock.on("data", onData);
    sock.once("end", () => {
      if (timer) clearTimeout(timer);
      reject(new Error("connection closed before response headers"));
    });
    sock.once("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
  });
}

/**
 * One-shot request. Resolves for ANY status; the caller maps >=400 to
 * errors. We send Connection: close, so the body simply ends at EOF
 * (dechunked first when the response is chunked); when Content-Length is
 * present it is verified against the delivered bytes, so a body truncated
 * by a clean early close rejects instead of resolving.
 */
export async function rawRequest(
  socketPath: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  timeoutMs: number,
  tracker?: SocketTracker,
): Promise<RawResponse> {
  const sock = await connect(socketPath, timeoutMs);
  track(sock, tracker);
  return new Promise<RawResponse>((resolve, reject) => {
    let settled = false;
    let head: Head | undefined;
    let payload: Buffer | undefined;
    const done = (action: () => void): void => {
      if (settled) return;
      settled = true;
      action();
    };
    sock.setTimeout(timeoutMs, () => {
      sock.destroy(new Error(`request to ${path} timed out after ${timeoutMs}ms`));
    });
    sock.on("data", (c: Buffer) => {
      if (!head) return;
      payload = payload && payload.length ? Buffer.concat([payload, c]) : c;
    });
    sock.once("end", () =>
      done(() => {
        if (!head) {
          // This handler is subscribed before readHead's own "end" one,
          // so it runs first and must not dereference a missing head.
          reject(new Error("connection closed before response headers"));
          return;
        }
        try {
          const chunked = head.headers["transfer-encoding"]?.includes("chunked");
          const body = payload ?? Buffer.alloc(0);
          if (!chunked) {
            // A clean close does not certify a complete body: with
            // Content-Length present, a short (or over-long) body is a
            // corrupt exchange and must not resolve as success -- the
            // client would parse truncated JSON as data or as "undefined".
            const declared = Number(head.headers["content-length"]);
            if (Number.isInteger(declared) && body.length !== declared) {
              throw new Error(
                `response body length ${body.length} does not match Content-Length ${declared} (${path})`,
              );
            }
          }
          resolve({
            status: head.status,
            headers: head.headers,
            body: chunked ? dechunkBuffer(body) : body,
          });
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      }),
    );
    sock.once("error", (e) => done(() => reject(e)));
    sock.once("close", () =>
      done(() =>
        reject(new Error("connection closed before the response completed")),
      ),
    );
    writeRequest(sock, method, path, headers, body);
    // ownTimer=false: the idle timer above already guards the headers
    // phase, and a second timer could race its rejection against the
    // "close" event that its own destroy() schedules.
    readHead(sock, timeoutMs, false).then(
      (h) => {
        head = h;
        payload = h.rest;
        // readHead paused the socket; from here on the data handler
        // above is safe to feed.
        sock.resume();
      },
      (e) => done(() => reject(e as Error)),
    );
  });
}

/**
 * Open a response body as a stream (SSE). Headers use `timeoutMs`; the
 * stream itself is untimed (the daemon heartbeats). Resolves for ANY
 * status; the caller maps >=400 to errors and destroys the stream.
 */
export async function rawStream(
  socketPath: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  timeoutMs: number,
  tracker?: SocketTracker,
): Promise<RawStreamResponse> {
  const sock = await connect(socketPath, timeoutMs);
  track(sock, tracker);
  writeRequest(sock, method, path, headers, undefined);
  const head = await readHead(sock, timeoutMs);
  sock.setTimeout(0); // the stream is long-lived; heartbeats keep it alive
  // head.rest holds bytes the header reader already consumed from the
  // socket (headers and the first body chunk coalesce on the wire); feed
  // them back in BEFORE piping, or the first SSE frames are lost.
  const stream: Transform = head.headers["transfer-encoding"]?.includes(
    "chunked",
  )
    ? new DechunkStream()
    : new PassThrough();
  if (head.rest.length > 0) stream.write(head.rest);
  sock.on("error", (e) => stream.destroy(e));
  stream.on("close", () => sock.destroy());
  sock.pipe(stream);
  return { status: head.status, headers: head.headers, stream };
}
