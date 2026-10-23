import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Mirrors internal/daemon/discovery.go + paths_unix.go (adrg/xdg semantics:
// XDG_* env wins on every OS, then the platform default). Order:
//   1. explicit override — the portato.socketPath setting, else PORTATO_SOCKET;
//      wins outright, exactly like SocketOverride() in the Go resolver
//   2. the marker file <configHome>/portato/daemon.socket — a JSON document
//      {"socket": "...", "pid": N}; the socket counts only if it answers
//      /healthz (probe supplied by the caller — DaemonClient)
//   3. the runtime socket path:
//        darwin: <stateHome>/portato/portato-<uid>.sock
//        linux:  $XDG_RUNTIME_DIR/portato-<uid>.sock; adrg/xdg v0.5.3 never
//                leaves RuntimeDir empty (paths_unix.go:27 falls back to
//                /run/user/<uid>), matching Go's effectively-unreachable
//                TempDir branch
//
// env-dependent: an extension host launched from the Dock on macOS does not
// inherit shell rc exports, so candidate [3] can diverge from a daemon
// started in a terminal — the socketPath override exists for that case.

interface Marker {
  socket?: string;
  pid?: number;
}

// The setting wins over the env var; an empty/whitespace setting falls
// through to PORTATO_SOCKET, mirroring the CLI (flag > env).
export function overrideSocketPath(setting?: string): string | undefined {
  const fromSetting = setting?.trim();
  if (fromSetting) return fromSetting;
  return process.env["PORTATO_SOCKET"] || undefined;
}

export function configHome(): string {
  const env = process.env["XDG_CONFIG_HOME"];
  if (env) return env;
  // adrg/xdg defaults: macOS ~/Library/Application Support, linux ~/.config.
  return process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support")
    : path.join(os.homedir(), ".config");
}

// macOS co-locates the runtime socket with the daemon log under the state
// home (a stable dir macOS never reaps); linux uses the per-user runtime
// dir or the temp dir.
function stateHome(): string {
  const env = process.env["XDG_STATE_HOME"];
  if (env) return env;
  return process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support")
    : path.join(os.homedir(), ".local", "state");
}

export function markerPath(): string {
  return path.join(configHome(), "portato", "daemon.socket");
}

function uid(): number {
  try {
    return os.userInfo().uid;
  } catch {
    return -1;
  }
}

export function runtimeSocketPath(): string {
  const name = `portato-${uid()}.sock`;
  if (process.platform === "darwin") {
    return path.join(stateHome(), "portato", name);
  }
  const runDir = process.env["XDG_RUNTIME_DIR"] || path.join("/run/user", String(uid()));
  return path.join(runDir, name);
}

// Resolves the daemon socket: override outright, then marker/runtime with a
// healthz probe. `probe` is async and cheap (300 ms timeout upstream); it is
// supplied by the caller so this module stays free of HTTP.
export async function resolveSocketPath(
  probe: (socketPath: string) => Promise<boolean>,
  setting?: string,
): Promise<string | undefined> {
  const override = overrideSocketPath(setting);
  if (override) return override;
  try {
    const raw = await fsp.readFile(markerPath(), "utf8");
    const marker = JSON.parse(raw) as Marker;
    // Mirror the Go ReadMarker validation: socket non-empty, pid > 0.
    if (
      typeof marker.socket === "string" &&
      marker.socket.length > 0 &&
      typeof marker.pid === "number" &&
      marker.pid > 0 &&
      (await probe(marker.socket))
    ) {
      return marker.socket;
    }
  } catch {
    // absent or unreadable marker is a normal "no daemon" case
  }
  const runtime = runtimeSocketPath();
  if (await probe(runtime)) return runtime;
  return undefined;
}

// The IPC bearer token lives next to the socket and is regenerated on every
// daemon start — never cache it across daemon restarts.
export function tokenPath(socketPath: string): string {
  return path.join(path.dirname(socketPath), "portato.token");
}
