import * as fsp from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import type { Readable } from "node:stream";
import { tokenPath } from "./discovery";
import type { Healthz, LogEntry, TuberStatus } from "./types";

// HTTP client over the daemon's unix socket. The transport mirrors
// internal/client/client.go: the agent dials the socket, every request
// attaches the bearer token read from tokenPath(socketPath), regular calls
// time out after 5 s, and a 401 triggers exactly one token re-read + retry
// (the token is regenerated on each daemon start, so a stale in-memory copy
// is a normal race, not an attack). The token file's absence (--ipc-token
// off) means: send no Authorization header.

const DEFAULT_TIMEOUT_MS = 5000;

// Routes every connection of an http.Agent through the daemon's unix
// socket (the URL host is a dummy).
class UnixSocketAgent extends http.Agent {
  constructor(private readonly socketPath: string) {
    super();
  }

  override createConnection(): net.Socket {
    return net.createConnection(this.socketPath);
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

async function readToken(socketPath: string): Promise<string> {
  try {
    return (await fsp.readFile(tokenPath(socketPath), "utf8")).trim();
  } catch {
    return "";
  }
}

export class DaemonClient {
  private readonly agent: UnixSocketAgent;
  private token: string;

  private constructor(
    readonly socketPath: string,
    token: string,
    private readonly timeoutMs: number,
  ) {
    this.token = token;
    this.agent = new UnixSocketAgent(socketPath);
  }

  static async create(
    socketPath: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<DaemonClient> {
    return new DaemonClient(
      socketPath,
      await readToken(socketPath),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  }

  /** Re-read the IPC token (regenerated on every daemon start). */
  async refreshToken(): Promise<void> {
    this.token = await readToken(this.socketPath);
  }

  /** Release the socket pool (used by tests and on shutdown). */
  destroy(): void {
    this.agent.destroy();
  }

  private url(p: string): string {
    // Dummy host; the agent routes to the unix socket regardless.
    return `http://portato${p}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return { ...h, ...extra };
  }

  private requestOnce(
    p: string,
    method: string,
    body: unknown,
    timeoutMs: number | null,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let payload: string | undefined;
      const headers = this.headers();
      if (body !== undefined) {
        payload = JSON.stringify(body);
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(payload).toString();
      }
      const req = http.request(this.url(p), { agent: this.agent, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let data: unknown;
          if (raw.length > 0) {
            try {
              data = JSON.parse(raw);
            } catch {
              data = undefined;
            }
          }
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve(data);
            return;
          }
          const msg =
            (data as { error?: string } | undefined)?.error ?? `HTTP ${status}`;
          reject(new HttpError(status, msg));
        });
      });
      req.on("error", reject);
      if (timeoutMs !== null && timeoutMs > 0) {
        req.setTimeout(timeoutMs, () => {
          req.destroy(new Error(`request to ${p} timed out after ${timeoutMs}ms`));
        });
      }
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  private async request(
    p: string,
    opts: { method?: string; body?: unknown; timeoutMs?: number | null } = {},
  ): Promise<unknown> {
    const method = opts.method ?? "GET";
    const timeoutMs = opts.timeoutMs === undefined ? this.timeoutMs : opts.timeoutMs;
    try {
      return await this.requestOnce(p, method, opts.body, timeoutMs);
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) {
        // Token rotated under us (daemon restarted): re-read once, retry once.
        await this.refreshToken();
        return this.requestOnce(p, method, opts.body, timeoutMs);
      }
      throw e;
    }
  }

  async healthz(): Promise<Healthz> {
    return (await this.request("/healthz")) as Healthz;
  }

  async tubers(): Promise<TuberStatus[]> {
    return ((await this.request("/tubers")) ?? []) as TuberStatus[];
  }

  async enable(name: string): Promise<void> {
    await this.request(`/tubers/${encodeURIComponent(name)}/enable`, { method: "POST" });
  }

  async disable(name: string): Promise<void> {
    await this.request(`/tubers/${encodeURIComponent(name)}/disable`, { method: "POST" });
  }

  async restart(name: string): Promise<void> {
    await this.request(`/tubers/${encodeURIComponent(name)}/restart`, { method: "POST" });
  }

  async acceptHost(name: string): Promise<void> {
    // Empty body: the daemon appends pending_host_line to known_hosts itself.
    await this.request(`/tubers/${encodeURIComponent(name)}/accept-host`, { method: "POST" });
  }

  async setPassphrase(name: string, passphrase: string): Promise<void> {
    await this.request(`/tubers/${encodeURIComponent(name)}/passphrase`, {
      method: "POST",
      body: { passphrase },
    });
  }

  async setPassword(name: string, password: string): Promise<void> {
    await this.request(`/tubers/${encodeURIComponent(name)}/password`, {
      method: "POST",
      body: { password },
    });
  }

  async logs(name?: string): Promise<LogEntry[]> {
    const p = name === undefined ? "/logs" : `/logs?name=${encodeURIComponent(name)}`;
    return ((await this.request(p)) ?? []) as LogEntry[];
  }

  /**
   * GET /events as a raw byte stream. No overall timeout (the server holds
   * the connection open and heartbeats every 15 s), but the RESPONSE HEADERS
   * use the regular timeout -- a wedged daemon accepts the connection and
   * never answers, and an unsettled open() would stall the reconnect loop.
   * The caller consumes lines and destroys the stream to abort.
   */
  async eventsStream(): Promise<Readable> {
    const openOnce = (): Promise<Readable> =>
      new Promise<Readable>((resolve, reject) => {
        const headers: Record<string, string> = {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
        };
        if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            // Reject FIRST: req.destroy() only triggers the 'error' event,
            // whose handler no-ops once `settled` is true.
            done(new Error(`GET /events timed out after ${this.timeoutMs}ms`));
            req.destroy();
          }
        }, this.timeoutMs);
        const done = (err: Error | null, res?: http.IncomingMessage): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) reject(err);
          else resolve(res as Readable);
        };
        const req = http.request(this.url("/events"), { agent: this.agent, method: "GET", headers }, (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 400) {
            res.resume();
            done(new HttpError(status, `GET /events failed: HTTP ${status}`));
            return;
          }
          done(null, res);
        });
        req.on("error", (e) => done(e));
        req.end();
      });
    try {
      return await openOnce();
    } catch (e) {
      // Symmetric with request(): the token can rotate between client
      // construction and this call (daemon restarted mid-reconnect).
      if (e instanceof HttpError && e.status === 401) {
        await this.refreshToken();
        return openOnce();
      }
      throw e;
    }
  }
}

/**
 * Liveness probe: /healthz within `timeoutMs`. Used by discovery and the
 * daemon lifecycle; one shared implementation so the timeout and the
 * wedged-socket treatment stay identical everywhere.
 */
export async function probeSocket(
  socketPath: string,
  timeoutMs = 300,
): Promise<boolean> {
  try {
    const client = await DaemonClient.create(socketPath, { timeoutMs });
    try {
      await client.healthz();
      return true;
    } finally {
      client.destroy();
    }
  } catch {
    return false;
  }
}
