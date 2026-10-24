import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import { DaemonClient } from "../daemonClient";
import { tokenPath } from "../discovery";
import { SseStream } from "../sse";
import { isActive, type TuberStatus } from "../types";
import { makeTempDir, sleep } from "./fakeDaemon";

// Integration test against a REAL, disposable portato daemon: isolated
// XDG_CONFIG_HOME / XDG_STATE_HOME / --socket keep it fully apart from any
// daemon the machine's owner is running (the single-instance flock lives
// under <ConfigHome>/portato/daemon.lock). The tuber points its SSH dial at
// 127.0.0.1:<closed port>, so no real SSH server is needed -- the exercise is
// the IPC contract: healthz, token auth, /tubers, SSE signals, enable/disable
// persistence, and `portato stop`.

// The binary is taken from $PORTATO_BINARY, else the Homebrew default when
// present. A bare "portato" candidate is useless: existsSync resolves it
// relative to the cwd, never through PATH.
const CANDIDATES = [process.env["PORTATO_BINARY"], "/opt/homebrew/bin/portato"];
const PORTATO = CANDIDATES.find((p): p is string => !!p && fs.existsSync(p)) ?? null;

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${what}`);
    await sleep(150);
  }
}

describe("integration: real daemon (disposable)", { skip: !PORTATO }, () => {
  let dir: string;
  let cfgHome: string;
  let stateHome: string;
  let sock: string;
  let env: NodeJS.ProcessEnv;
  let daemon: ChildProcess;
  let client: DaemonClient | undefined;

  before(async () => {
    dir = await makeTempDir();
    cfgHome = path.join(dir, "cfg");
    stateHome = path.join(dir, "state");
    sock = path.join(dir, "daemon.sock");
    const localPort = await freePort();
    await fsp.mkdir(path.join(cfgHome, "portato"), { recursive: true });
    await fsp.writeFile(
      path.join(cfgHome, "portato", "config.yaml"),
      [
        "tubers:",
        "  - name: itest",
        "    type: local",
        `    local: "127.0.0.1:${localPort}"`,
        "    remote: \"127.0.0.1:1\"",
        "    ssh: \"itest@127.0.0.1:1\"",
        "    enabled: false",
        "",
      ].join("\n"),
    );
    env = { ...process.env, XDG_CONFIG_HOME: cfgHome, XDG_STATE_HOME: stateHome };
    daemon = spawn(PORTATO as string, ["daemon", "--socket", sock], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    daemon.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    daemon.on("exit", (code) => {
      if (code !== null && code !== 0) console.error(`daemon exited ${code}: ${stderr}`);
    });
    // Readiness: token file written AND /healthz answers.
    await waitFor(async () => {
      try {
        await fsp.access(tokenPath(sock));
        const c = await DaemonClient.create(sock, { timeoutMs: 500 });
        try {
          await c.healthz();
          return true;
        } finally {
          c.destroy();
        }
      } catch {
        return false;
      }
    }, 10_000, "daemon readiness");
  });

  after(async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(PORTATO as string, ["stop"], { env, timeout: 10_000 }, (err) =>
          err ? reject(err) : resolve(),
        );
      });
    } catch {
      daemon?.kill("SIGKILL");
    }
    client?.destroy();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("healthz answers with the bearer token enforced", async () => {
    client = await DaemonClient.create(sock);
    const health = await client.healthz();
    assert.equal(health.ok, true);

    // Without the token the daemon must reject us (401).
    const tokenFile = tokenPath(sock);
    const stashed = path.join(dir, "portato.token.stashed");
    await fsp.rename(tokenFile, stashed);
    try {
      const anon = await DaemonClient.create(sock);
      try {
        await assert.rejects(() => anon.healthz(), /unauthorized/i);
      } finally {
        anon.destroy();
      }
    } finally {
      await fsp.rename(stashed, tokenFile);
    }
  });

  it("GET /tubers reflects the config; SSE signals every state change", async () => {
    client = client ?? (await DaemonClient.create(sock));

    const initial = await client.tubers();
    assert.equal(initial.length, 1);
    const itest = initial[0] as TuberStatus;
    assert.equal(itest.name, "itest");
    assert.equal(itest.state, "off");

    // SSE: first frame arrives immediately and signals the initial load.
    let signals = 0;
    const sse = new SseStream(
      { open: () => client!.eventsStream() },
      { onSignal: () => signals++ },
      { debounceMs: 60, initialBackoffMs: 250, watchdogMs: 5000 },
    );
    sse.start();
    await waitFor(async () => signals > 0, 5000, "initial SSE signal");

    // enable: expect a signal and a state change away from "off".
    const before = signals;
    await client.enable("itest");
    await waitFor(async () => signals > before, 5000, "signal after enable");
    await waitFor(
      async () => (await client!.tubers())[0]?.state !== "off",
      10_000,
      "state change after enable",
    );
    const mid = (await client.tubers())[0] as TuberStatus;
    assert.ok(["connecting", "connected", "reconnecting", "error"].includes(mid.state));

    // disable: back to "off" with another signal.
    const before2 = signals;
    await client.disable("itest");
    await waitFor(async () => signals > before2, 5000, "signal after disable");
    await waitFor(
      async () => (await client!.tubers())[0]?.state === "off",
      10_000,
      "state off after disable",
    );
    assert.ok(!isActive((await client.tubers())[0] as TuberStatus));
    sse.stop();
  });

  it("enable persists `enabled` to the config file (restart survival)", async () => {
    client = client ?? (await DaemonClient.create(sock));
    await client.enable("itest");
    const raw = await fsp.readFile(path.join(cfgHome, "portato", "config.yaml"), "utf8");
    assert.match(raw, /enabled:\s*true/);
    await client.disable("itest");
  });
});
