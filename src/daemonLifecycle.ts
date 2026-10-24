import { execFile, spawn } from "node:child_process";
import { open, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { probeSocket } from "./daemonClient";
import { markerPath, overrideSocketPath, resolveSocketPath } from "./discovery";
import { decodeLaunchTail } from "./launchLog";

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
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, offset);
      return decodeLaunchTail(buffer, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

/**
 * Discovery that returns only a PROVEN-live socket. An override path resolves
 * from the setting/env without probing (resolveSocketPath's contract), so it
 * gets an explicit probe; marker/runtime candidates were probed by discovery
 * already and must not be probed twice per call.
 */
async function resolveLiveSocket(): Promise<string | undefined> {
  const override = settingOverride();
  const socket = await resolveSocketPath(probeSocket, override);
  if (!socket) return undefined;
  if (!override) return socket;
  return (await probeSocket(socket)) ? socket : undefined;
}

/**
 * Start the daemon and wait until discovery + /healthz confirm it is up
 * (<=5 s). Resolves with the socket path; rejects with the daemon's stderr.
 * A daemon that is already live is a no-op success -- spawning anyway would
 * just bounce off the single-instance flock.
 */
export async function startDaemon(): Promise<string> {
  const alreadyLive = await resolveLiveSocket();
  if (alreadyLive) return alreadyLive;

  const state = await spawnDaemon();
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  for (;;) {
    if (state.exited) {
      // "daemon already running" exits leave the FIRST daemon alive -- if
      // discovery finds a live one, the start counts as a success.
      const live = await resolveLiveSocket();
      if (live) return live;
      const log = await readLaunchLog(state.logOffset);
      throw new Error(
        log ||
          vscode.l10n.t(
            'failed to run "{0}" -- check the portato.binaryPath setting',
            binaryPath(),
          ),
      );
    }
    const socket = await resolveLiveSocket();
    if (socket) return socket;
    if (Date.now() > deadline) {
      const log = await readLaunchLog(state.logOffset);
      throw new Error(
        vscode.l10n.t("daemon did not become ready within {0}s{1}", READINESS_TIMEOUT_MS / 1000, log ? `: ${log}` : ""),
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
