import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Mirrors internal/daemon/discovery.go + paths_unix.go. Order:
//   1. explicit override (the portato.socketPath setting, or PORTATO_SOCKET)
//   2. the marker file <configHome>/portato/daemon.socket — a JSON document
//      {"socket": "...", "pid": N}; the socket counts only if it answers
//      /healthz with the current IPC token (that probe lives in DaemonClient)
//   3. the runtime socket path:
//        linux:  $XDG_RUNTIME_DIR/portato-<uid>.sock, else os.tmpdir()
//        macos:  ~/Library/Application Support/portato/portato-<uid>.sock
//
// env-dependent: an extension host launched from the Dock on macOS does not
// inherit shell rc exports, so candidate [3] can diverge from a daemon
// started in a terminal — the socketPath override exists for that case.

interface Marker {
  socket?: string;
  pid?: number;
}

export function overrideSocketPath(): string | undefined {
  return process.env["PORTATO_SOCKET"] || undefined;
}

export function configHome(): string {
  return process.env["XDG_CONFIG_HOME"] || path.join(os.homedir(), ".config");
}

export function markerPath(): string {
  return path.join(configHome(), "portato", "daemon.socket");
}

function uid(): number {
  return os.userInfo().uid;
}

export function runtimeSocketPath(): string {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "portato",
      `portato-${uid()}.sock`,
    );
  }
  const runDir = process.env["XDG_RUNTIME_DIR"] || os.tmpdir();
  return path.join(runDir, `portato-${uid()}.sock`);
}

// Candidate socket paths, most specific first. The first that answers
// /healthz wins; probing is DaemonClient's job (part 1).
export function candidateSocketPaths(): string[] {
  const out: string[] = [];
  const override = overrideSocketPath();
  if (override) out.push(override);
  try {
    const raw = fs.readFileSync(markerPath(), "utf8");
    const marker = JSON.parse(raw) as Marker;
    if (marker.socket) out.push(marker.socket);
  } catch {
    // absent or unreadable marker is a normal "no daemon" case
  }
  out.push(runtimeSocketPath());
  return [...new Set(out)].filter((p) => p.length > 0);
}

// The IPC bearer token lives next to the socket and is regenerated on every
// daemon start — never cache it across daemon restarts.
export function tokenPath(socketPath: string): string {
  return path.join(path.dirname(socketPath), "portato.token");
}
