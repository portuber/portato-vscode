// Mirror of the daemon IPC contract. Source of truth: the Go repo
// (internal/forward/state.go, internal/log/ring.go, internal/daemon/server.go).
// When the daemon API changes, update this file in the same PR.

export type TuberType = "local" | "remote" | "dynamic";

// forward.State marshals to exactly these five names; unknown names map to
// "off" on the Go side, so the union is closed.
export type TuberState =
  | "off"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface TuberStatus {
  readonly name: string;
  readonly type: TuberType;
  readonly local: string;
  readonly remote: string;
  readonly state: TuberState;
  readonly error?: string;
  // Always present; the zero time "0001-01-01T00:00:00Z" means "never".
  readonly connected_at: string;
  readonly tags?: string[];

  // TOFU host-key prompt; non-empty only while state is "connecting".
  readonly pending_host?: string;
  readonly pending_fingerprint?: string;
  readonly pending_host_line?: string;

  // Passphrase prompt (identity path); the dial blocks until one arrives.
  readonly pending_passphrase?: string;
  readonly passphrase_attempts?: number;

  // Password prompt ("password:<user>@<host>:<port>"); dial blocks likewise.
  readonly pending_password?: string;
  readonly password_attempts?: number;
}

export interface LogEntry {
  readonly time: string;
  // A slog.Level string form; "DEBUG".."ERROR" plus shifted forms like "INFO+2".
  readonly level: string;
  readonly tuber?: string;
  readonly msg: string;
  // Pre-rendered "k=v k2=v2" attribute string.
  readonly attrs?: string;
}

export interface Healthz {
  readonly ok: boolean;
}

export function isActive(s: TuberStatus): boolean {
  return s.state === "connected";
}

// Prompting = state "connecting" plus a non-empty pending flag; there is no
// separate prompting state in the daemon.
export function pendingPrompt(s: TuberStatus): {
  kind: "hostkey" | "passphrase" | "password";
  detail: string;
  fingerprint?: string;
  attempts: number;
} | null {
  if (s.state !== "connecting") return null;
  if (s.pending_host) {
    return {
      kind: "hostkey",
      detail: s.pending_host,
      fingerprint: s.pending_fingerprint,
      attempts: 0,
    };
  }
  if (s.pending_passphrase) {
    return {
      kind: "passphrase",
      detail: s.pending_passphrase,
      attempts: s.passphrase_attempts ?? 0,
    };
  }
  if (s.pending_password) {
    return {
      kind: "password",
      detail: s.pending_password,
      attempts: s.password_attempts ?? 0,
    };
  }
  return null;
}

// Endpoint rendering parity with forward.Status.Endpoint(): the arrow encodes
// the direction of traffic.
export function endpoint(s: TuberStatus): string {
  switch (s.type) {
    case "remote":
      return `${s.local} ← ${s.remote}`;
    case "dynamic":
      return `${s.local} ⇄ *`;
    default:
      return `${s.local} → ${s.remote}`;
  }
}
