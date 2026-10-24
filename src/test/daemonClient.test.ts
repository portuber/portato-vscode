import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import type * as http from "node:http";
import { DaemonClient } from "../daemonClient";
import type { TuberStatus } from "../types";
import { makeTempDir, sleep, startFakeDaemon, type FakeDaemon } from "./fakeDaemon";

const TOKEN = "test-token-abc";

function tuber(name: string): TuberStatus {
  return {
    name,
    type: "local",
    local: "localhost:8080",
    remote: "example.com:80",
    state: "off",
    connected_at: "0001-01-01T00:00:00Z",
  };
}

async function json(res: http.ServerResponse, status: number, body: unknown): Promise<void> {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

describe("DaemonClient", () => {
  let dir: string;

  before(async () => {
    dir = await makeTempDir();
  });

  after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("healthz + bearer token from the file next to the socket", async (t) => {
    const daemon = await startFakeDaemon({
      dir,
      token: TOKEN,
      handler: async (_req, res) => {
        await json(res, 200, { ok: true });
      },
    });
    t.after(async () => {
      await daemon.close();
    });
    const client = await DaemonClient.create(daemon.socketPath);
    t.after(() => client.destroy());
    assert.deepEqual(await client.healthz(), { ok: true });
    assert.equal(daemon.requests[0]?.headers["authorization"], `Bearer ${TOKEN}`);
  });

  it("no token file -> no Authorization header", async (t) => {
    const daemon = await startFakeDaemon({
      dir,
      handler: async (_req, res) => {
        await json(res, 200, { ok: true });
      },
    });
    t.after(async () => {
      await daemon.close();
    });
    const client = await DaemonClient.create(daemon.socketPath);
    t.after(() => client.destroy());
    await client.healthz();
    assert.equal(daemon.requests[0]?.headers["authorization"], undefined);
  });

  it("401 rotates the token: re-read once, retry once, then succeed", async (t) => {
    let daemon: FakeDaemon;
    daemon = await startFakeDaemon({
      dir,
      token: "old-token",
      handler: async (req, res) => {
        if (req.headers["authorization"] !== "Bearer new-token") {
          await json(res, 401, { error: "unauthorized" });
          // Rotate the token as a daemon restart would.
          await daemon.setToken("new-token");
          return;
        }
        await json(res, 200, { ok: true });
      },
    });
    t.after(async () => {
      await daemon.close();
    });
    const client = await DaemonClient.create(daemon.socketPath);
    t.after(() => client.destroy());
    assert.deepEqual(await client.healthz(), { ok: true });
    assert.equal(daemon.requests.length, 2);
    assert.equal(daemon.requests[1]?.headers["authorization"], "Bearer new-token");
  });

  it("a second 401 is not retried forever", async (t) => {
    const daemon = await startFakeDaemon({
      dir,
      token: TOKEN,
      handler: async (_req, res) => {
        await json(res, 401, { error: "unauthorized" });
      },
    });
    t.after(async () => {
      await daemon.close();
    });
    const client = await DaemonClient.create(daemon.socketPath);
    t.after(() => client.destroy());
    await assert.rejects(() => client.healthz(), /unauthorized/);
    assert.equal(daemon.requests.length, 2); // original + one retry
  });

  it("error bodies surface the daemon's message and unknown tuber is 404", async (t) => {
    const daemon = await startFakeDaemon({
      dir,
      token: TOKEN,
      handler: async (req, res) => {
        if (req.url === "/tubers/ghost/enable") {
          await json(res, 404, { error: "unknown tuber \"ghost\"" });
          return;
        }
        await json(res, 200, []);
      },
    });
    t.after(async () => {
      await daemon.close();
    });
    const client = await DaemonClient.create(daemon.socketPath);
    t.after(() => client.destroy());
    await assert.rejects(() => client.enable("ghost"), /unknown tuber/);
  });

  it("tubers() parses the status array", async (t) => {
    const statuses = [tuber("web"), { ...tuber("db"), state: "connected" }];
    const daemon = await startFakeDaemon({
      dir,
      token: TOKEN,
      handler: async (_req, res) => {
        await json(res, 200, statuses);
      },
    });
    t.after(async () => {
      await daemon.close();
    });
    const client = await DaemonClient.create(daemon.socketPath);
    t.after(() => client.destroy());
    assert.deepEqual(await client.tubers(), statuses);
  });

  it("names are URL-encoded; passphrase/password bodies use their own keys", async (t) => {
    const daemon = await startFakeDaemon({
      dir,
      token: TOKEN,
      handler: async (_req, res) => {
        await json(res, 200, {});
      },
    });
    t.after(async () => {
      await daemon.close();
    });
    const client = await DaemonClient.create(daemon.socketPath);
    t.after(() => client.destroy());
    const name = "my tunnel/extra";
    await client.setPassphrase(name, "secret1");
    await client.setPassword(name, "secret2");
    await client.acceptHost(name);
    const [pp, pw, ah] = daemon.requests;
    assert.equal(pp?.url, `/tubers/${encodeURIComponent(name)}/passphrase`);
    assert.deepEqual(JSON.parse(pp?.body ?? "{}"), { passphrase: "secret1" });
    assert.equal(pw?.url, `/tubers/${encodeURIComponent(name)}/password`);
    assert.deepEqual(JSON.parse(pw?.body ?? "{}"), { password: "secret2" });
    assert.equal(ah?.url, `/tubers/${encodeURIComponent(name)}/accept-host`);
    assert.equal(ah?.body, ""); // empty body -- the daemon appends the line
  });

  it("enable/disable/restart/log paths", async (t) => {
    const daemon = await startFakeDaemon({
      dir,
      token: TOKEN,
      handler: async (_req, res) => {
        await json(res, 200, []);
      },
    });
    t.after(async () => {
      await daemon.close();
    });
    const client = await DaemonClient.create(daemon.socketPath);
    t.after(() => client.destroy());
    await client.enable("a b");
    await client.disable("a b");
    await client.restart("a b");
    await client.logs();
    await client.logs("a b");
    assert.deepEqual(
      daemon.requests.map((r) => r.url),
      [
        "/tubers/a%20b/enable",
        "/tubers/a%20b/disable",
        "/tubers/a%20b/restart",
        "/logs",
        "/logs?name=a%20b",
      ],
    );
  });

  it("request timeout rejects instead of hanging", async (t) => {
    const daemon = await startFakeDaemon({
      dir,
      token: TOKEN,
      handler: async (_req, res) => {
        await sleep(800);
        await json(res, 200, { ok: true });
      },
    });
    t.after(async () => {
      await daemon.close();
    });
    const client = await DaemonClient.create(daemon.socketPath, { timeoutMs: 100 });
    t.after(() => client.destroy());
    await assert.rejects(() => client.healthz(), /timed out/);
  });

  it("eventsStream: SSE headers, raw bytes, no overall timeout", async (t) => {
    const daemon = await startFakeDaemon({
      dir,
      token: TOKEN,
      handler: async (req, res) => {
        assert.equal(req.headers["accept"], "text/event-stream");
        assert.equal(req.headers["cache-control"], "no-cache");
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("data: {}\n\n");
        setTimeout(() => res.write(": heartbeat\n\n"), 30);
      },
    });
    t.after(async () => {
      await daemon.close();
    });
    // 50 ms regular-call timeout must NOT kill the long-lived stream.
    const client = await DaemonClient.create(daemon.socketPath, { timeoutMs: 50 });
    t.after(() => client.destroy());
    const stream = await client.eventsStream();
    // Read raw lines until the heartbeat comment shows up; chunk boundaries
    // are not guaranteed, so scan rather than assume per-readline framing.
    const lines: string[] = [];
    const first = await readLine(stream);
    assert.equal(first, "data: {}");
    const deadline = Date.now() + 2000;
    while (!lines.includes(": heartbeat") && Date.now() < deadline) {
      lines.push(await readLine(stream));
    }
    assert.ok(lines.includes(": heartbeat"), `lines=${JSON.stringify(lines)}`);
    stream.destroy();
  });

  it("eventsStream: wedged daemon (no headers) rejects within timeoutMs", async (t) => {
    const daemon = await startFakeDaemon({
      dir,
      token: TOKEN,
      // Accept the connection, never write headers -- the wedged-daemon case.
      // The timer is unref'd and the wait aborts on socket close so the test
      // process can exit as soon as the suite is done.
      handler: (_req, res) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 30_000);
          timer.unref();
          res.on("close", () => {
            clearTimeout(timer);
            resolve();
          });
        }),
    });
    t.after(async () => {
      await daemon.close();
    });
    const client = await DaemonClient.create(daemon.socketPath, { timeoutMs: 100 });
    t.after(() => client.destroy());
    await assert.rejects(() => client.eventsStream(), /timed out/);
  });
});

function readLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        cleanup();
        resolve(buf.slice(0, idx).replace(/\r$/, ""));
      }
    };
    const onErr = (e: Error) => {
      cleanup();
      reject(e);
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("error", onErr);
    };
    stream.on("data", onData);
    stream.on("error", onErr);
  });
}
