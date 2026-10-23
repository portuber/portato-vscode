import { execFile, spawn } from "node:child_process";
import { open, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { DaemonClient } from "./daemonClient";
import { markerPath, overrideSocketPath, resolveSocketPath } from "./discovery";

// `portato daemon` runs in the FOREGROUND. Launch it detached so it survives
// the extension host: { detached: true, stdio: ["ignore","ignore",<file>] }
// + unref(). stderr goes to a log file (never through argv): a pipe owned by
// the extension host would close on host exit, and Go dies on SIGPIPE when a
// later stderr write hits the broken fd 2.
//
// Readiness = discovery finds a socket that answers /healthz (NOT the socket
// file appearing -- it shows up before the token file is written).
// Stop is delegated to the CLI (`portato stop`) -- it is idempotent, signals
// the marker PID and heals wedged daemons; we do not reimplement it.

const execFileAsync = promisify(execFile);
const READINESS_POLL_MS = 250;
const READINESS_TIMEOUT_MS = 5000;
const STDERR_CAP = 2048; // max launch-log tail surfaced in an error message

export function binaryPath(): string {
  return vscode.workspace.getConfiguration("portato").get<string>("binaryPath") || "portato";
}

export function settingOverride(): string | undefined {
  return overrideSocketPath(
    vscode.workspace.getConfiguration("portato").get<string>("socketPath"),
  );
}

function socketOverrideArgs(): string[] {
  // When an override is active the spawned daemon must bind the same path
  // the client will dial -- pass --socket explicitly (env alone would also
  // propagate, but being explicit survives shells that scrub env).
  const override = settingOverride();
  return override ? ["--socket", override] : [];
}

interface SpawnState {
  /** Mutable: set by the exit/error handlers long after the promise resolves. */
  exited: boolean;
  logOffset: number;
}

async function spawnDaemon(): Promise<SpawnState> {
  const logPath = launchLogPath();
  await mkdir(dirname(logPath), { recursive: true });
  const log = await open(logPath, "a");
  const logOffset = (await log.stat()).size;
  const state: SpawnState = { exited: false, logOffset };
  let child;
  try {
    child = spawn(binaryPath(), ["daemon", ...socketOverrideArgs()], {
      detached: true,
      stdio: ["ignore", "ignore", log.fd],
    });
  } finally {
    // The child owns its own copy of the fd; close ours.
    await log.close().catch(() => undefined);
  }
  child.on("error", () => {
    state.exited = true;
  });
  child.on("exit", () => {
    state.exited = true;
  });
  child.unref();
  return state;
}

/** Daemon stderr capture: <ConfigHome>/portato/daemon-launch.log */
function launchLogPath(): string {
  return join(dirname(markerPath()), "daemon-launch.log");
}

async function readLaunchLog(offset: number): Promise<string> {
  try {
    const handle = await open(launchLogPath(), "r");
    try {
      const { size } = await handle.stat();
      const length = Math.min(Math.max(size - offset, 0), STDERR_CAP);
      if (length === 0) return "";
      const { buffer } = await handle.read(Buffer.alloc(length), 0, length, offset);
      return buffer.toString("utf8").trim();
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

async function probe(socketPath: string): Promise<boolean> {
  try {
    const client = await DaemonClient.create(socketPath, { timeoutMs: 300 });
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

/**
 * Start the daemon and wait until discovery + /healthz confirm it is up
 * (<=5 s). Resolves with the socket path; rejects with the daemon's stderr.
 */
export async function startDaemon(): Promise<string> {
  const state = await spawnDaemon();
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  for (;;) {
    // An override resolves without probing, so the resolved path must be
    // probed explicitly before we call the daemon ready.
    if (state.exited) {
      // "daemon already running" exits leave the FIRST daemon alive -- if
      // discovery finds a live one, the start counts as a success.
      const live = await resolveSocketPath(probe, settingOverride());
      if (live && (await probe(live))) return live;
      const log = await readLaunchLog(state.logOffset);
      throw new Error(
        log ||
          `failed to run "${binaryPath()}" -- check the portato.binaryPath setting`,
      );
    }
    const socket = await resolveSocketPath(probe, settingOverride());
    if (socket && (await probe(socket))) return socket;
    if (Date.now() > deadline) {
      const log = await readLaunchLog(state.logOffset);
      throw new Error(
        `daemon did not become ready within ${READINESS_TIMEOUT_MS / 1000}s${log ? `: ${log}` : ""}`,
      );
    }
    await new Promise((r) => setTimeout(r, READINESS_POLL_MS));
  }
}

/**
 * `portato stop` via the CLI: idempotent (exit 0 with "no daemon running").
 * We never signal the daemon ourselves. The same --socket override is passed
 * so the CLI resolves the daemon this extension started.
 */
export async function stopDaemon(): Promise<string> {
  const { stdout } = await execFileAsync(binaryPath(), ["stop", ...socketOverrideArgs()], {
    timeout: 10_000,
  });
  return stdout.trim();
}
