import { join } from "node:path";
import type { PortatoConfig, TuberStatus } from "./types";

// Identity-passphrase candidate paths for a tuber. The daemon keys its
// passphrase cache (POST/DELETE /identities) by the exact path its dial
// resolved: config.Tuber.ResolvedIdentity expands a leading `~`
// (internal/config/config.go expandTilde) and joins with filepath.Join
// (which also cleans `..`/duplicate separators), and the CLI identity
// commands key the keyring the same way. Candidates are therefore expanded
// and normalized before they are offered or deduped, so the extension never
// stores a passphrase under a path the dial will not look up.

/**
 * Mirror of config.go expandTilde: "~" and "~/..." (also "~\...") resolve
 * against `home` via path.join, matching Go's filepath.Join normalization
 * (path.Clean semantics) for the unix-only daemon; anything else --
 * including "~user/..." and paths not starting with "~" -- passes through
 * unchanged.
 */
export function expandTilde(p: string, home: string): string {
  if (p === "" || !p.startsWith("~")) return p;
  if (p === "~") return home;
  const rest = p.slice(1);
  if (rest.startsWith("/") || rest.startsWith("\\")) {
    return join(home, rest.slice(1));
  }
  return p;
}

export interface IdentityCandidate {
  readonly path: string;
  /**
   * Quick-pick annotation shown when the path may not be the one the dial
   * actually resolves; the user confirms knowingly.
   */
  readonly note?: string;
}

/**
 * Candidate identity paths for a tunnel. The chain mirrors config.go
 * ResolvedIdentity with one unavoidable gap: the ssh-config IdentityFile
 * step sits between the tuber's own identity and defaults.identity, and
 * SSHIdentity is json:"-", so it never appears in GET /config. When the
 * daemon reports a pending_passphrase it IS the resolved path the dial
 * waits on, so it leads the list. defaults.identity alone is the weakest
 * guess (an IdentityFile may shadow it per host) and carries a note; the
 * only complete fix is the daemon exposing the resolved path.
 * `home` is the user's home directory (os.homedir() at the call site): the
 * extension runs UI-side ("extensionKind: ui") on the same host as the
 * daemon, so expanding here keys the cache exactly the way the dial does.
 */
export function identityCandidates(
  name: string,
  cfg: PortatoConfig,
  statuses: readonly TuberStatus[],
  home: string,
): IdentityCandidate[] {
  const out: IdentityCandidate[] = [];
  const push = (c: IdentityCandidate): void => {
    if (c.path && !out.some((x) => x.path === c.path)) out.push(c);
  };
  const pending = statuses.find((s) => s.name === name)?.pending_passphrase;
  if (pending) push({ path: pending });
  const tuberIdentity = cfg.tubers.find((t) => t.name === name)?.identity;
  if (tuberIdentity && tuberIdentity.trim() !== "") {
    push({ path: expandTilde(tuberIdentity, home) });
  } else {
    const defaultIdentity = cfg.defaults?.identity;
    if (defaultIdentity && defaultIdentity.trim() !== "") {
      push({
        path: expandTilde(defaultIdentity, home),
        note: "default identity -- a per-host IdentityFile in ~/.ssh/config takes precedence",
      });
    }
  }
  return out;
}
