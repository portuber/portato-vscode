import * as fsp from "node:fs/promises";
import * as net from "node:net";
import type { Readable } from "node:stream";
import { tokenPath } from "./discovery";
import { rawRequest, rawStream, type SocketTracker } from "./rawHttp";
import type { Healthz, LogEntry, PortatoConfig, ConfigTuber, TuberStatus } from "./types";

// HTTP client over the daemon's unix socket. The transport mirrors
// internal/client/client.go: every request attaches the bearer token read
// from tokenPath(socketPath), regular calls time out after 5 s, and a 401
// triggers exactly one token re-read + retry (the token is regenerated on
// each daemon start, so a stale in-memory copy is a normal race, not an
// attack). The token file's absence (--ipc-token off) means: send no
// Authorization header.
//
// The transport is raw HTTP over net.Socket (src/rawHttp.ts), NOT
// node:http: VS Code patches http.request in the extension host
// (vscode-proxy-agent) and routes unix-socket requests through DNS, which
// fails with getaddrinfo ENOTFOUND under the default http.proxySupport
// "override".

const DEFAULT_TIMEOUT_MS = 5000;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** HTTP status of a daemon error, or undefined for transport failures. */
export function httpStatusOf(e: unknown): number | undefined {
  return e instanceof HttpError ? e.status : undefined;
}

async function readToken(socketPath: string): Promise<string> {
  try {
    return (await fsp.readFile(tokenPath(socketPath), "utf8")).trim();
  } catch {
    return "";
  }
}

export class DaemonClient {
  private token: string;
  private readonly sockets: SocketTracker = new Set();

  private constructor(
    readonly socketPath: string,
    token: string,
    private readonly timeoutMs: number,
  ) {
    this.token = token;
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

  /** Release open sockets (used by tests and on shutdown). */
  destroy(): void {
    for (const sock of this.sockets) sock.destroy();
    this.sockets.clear();
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return { ...h, ...extra };
  }

  private async requestOnce(
    p: string,
    method: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const headers = this.headers();
    let payload: Buffer | undefined;
    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body), "utf8");
      headers["Content-Type"] = "application/json";
    }
    const res = await rawRequest(
      this.socketPath,
      method,
      p,
      headers,
      payload,
      timeoutMs,
      this.sockets,
    );
    const raw = res.body.toString("utf8");
    let data: unknown;
    if (raw.length > 0) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = undefined;
      }
    }
    if (res.status >= 200 && res.status < 300) {
      return data;
    }
    const msg =
      (data as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`;
    throw new HttpError(res.status, msg);
  }

  private async request(
    p: string,
    opts: { method?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const method = opts.method ?? "GET";
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
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

  /** The daemon's live config. The defaults carry secrets -- never log this. */
  async config(): Promise<PortatoConfig> {
    return (await this.request("/config")) as PortatoConfig;
  }

  async addTuber(tuber: ConfigTuber): Promise<void> {
    await this.request("/tubers", { method: "POST", body: tuber });
  }

  /**
   * PUT replaces the tuber wholesale (rename allowed). The body must carry
   * EVERY field of the config Tuber -- the daemon patches the YAML with
   * exactly what it receives, so a dropped field is silently lost.
   */
  async updateTuber(name: string, tuber: ConfigTuber): Promise<void> {
    await this.request(`/tubers/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: tuber,
    });
  }

  async deleteTuber(name: string): Promise<void> {
    await this.request(`/tubers/${encodeURIComponent(name)}`, { method: "DELETE" });
  }

  /** Reorder within the config list; out-of-range deltas are a 200 no-op. */
  async move(name: string, delta: number): Promise<void> {
    await this.request(`/tubers/${encodeURIComponent(name)}/move?delta=${delta}`, {
      method: "POST",
    });
  }

  /** Re-read config.yaml from disk (the daemon watches it too). */
  async reload(): Promise<void> {
    await this.request("/reload", { method: "POST" });
  }

  /** Cache/passphrase-store an identity, keyed by the EXACT path string. */
  async setIdentity(path: string, passphrase: string): Promise<void> {
    await this.request("/identities", { method: "POST", body: { path, passphrase } });
  }

  async forgetIdentity(path: string): Promise<void> {
    await this.request(`/identities?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
    });
  }

  /**
   * GET /events as a raw byte stream. No overall timeout (the server holds
   * the connection open and heartbeats every 15 s), but the RESPONSE HEADERS
   * use the regular timeout -- a wedged daemon accepts the connection and
   * never answers, and an unsettled open() would stall the reconnect loop.
   * The caller consumes lines and destroys the stream to abort.
   */
  async eventsStream(): Promise<Readable> {
    const openOnce = async (): Promise<Readable> => {
      const headers = this.headers({
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      });
      const res = await rawStream(
        this.socketPath,
        "GET",
        "/events",
        headers,
        this.timeoutMs,
        this.sockets,
      );
      if (res.status >= 400) {
        res.stream.destroy();
        throw new HttpError(res.status, `GET /events failed: HTTP ${res.status}`);
      }
      return res.stream;
    };
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
