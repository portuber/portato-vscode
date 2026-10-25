import type { TuberStatus } from "./types";

// Address/URL builders for the tree context actions (consult verdicts):
// wildcard binds are rewritten to the loopback before anything is opened,
// copied or handed to a browser, and the SOCKS URL carries the user at
// most -- the password is structurally impossible here (the builder never
// receives it), and nothing in this module logs.

export interface HostPort {
  host: string;
  port: string;
}

/**
 * Split "host:port" at the LAST colon (an IPv6 host may contain colons;
 * bracketed forms like "[::1]" pass through untouched). An empty host
 * (":8080", Go's "all interfaces" listen form) is valid and normalizes to
 * the loopback later. No colon or a trailing one returns undefined -- the
 * actions no-op instead of pasting garbage into a clipboard.
 */
export function splitHostPort(addr: string): HostPort | undefined {
  const i = addr.lastIndexOf(":");
  if (i < 0 || i === addr.length - 1) return undefined;
  return { host: addr.slice(0, i), port: addr.slice(i + 1) };
}

/**
 * Wildcard binds ("" / 0.0.0.0 / :: / [::]) mean "all interfaces"; for
 * opening and copying, the loopback is what the user can actually reach.
 */
export function normalizeHost(host: string): string {
  if (host === "" || host === "0.0.0.0" || host === "::" || host === "[::]") {
    return "127.0.0.1";
  }
  return host;
}

/** The tunnel's local endpoint, wildcard-normalized; undefined if malformed. */
export function localAddress(s: TuberStatus): string | undefined {
  const hp = splitHostPort(s.local);
  return hp ? `${normalizeHost(hp.host)}:${hp.port}` : undefined;
}

/**
 * Browser target for a local forward only (remote/dynamic endpoints are
 * not pages to open). Scheme is http: the daemon carries no scheme hint.
 */
export function browserUrl(s: TuberStatus): string | undefined {
  if (s.type !== "local") return undefined;
  const a = localAddress(s);
  return a ? `http://${a}` : undefined;
}

/**
 * The daemon's SOCKS username rule (internal/config/config.go,
 * ResolvedSocks5User): the tuber's own socks5_user wins when non-blank
 * after trimming; otherwise the config default applies verbatim. The
 * extension must mirror it or Copy SOCKS URL embeds a user that fails
 * auth. The caller passes tuberUser as undefined when the tuber is
 * missing from the config; the default then applies.
 */
export function resolvedSocks5User(
  tuberUser: string | undefined,
  defaultsUser: string | undefined,
): string {
  if (tuberUser !== undefined && tuberUser.trim() !== "") return tuberUser;
  return defaultsUser ?? "";
}

/**
 * SOCKS URL for a dynamic tunnel only. `user` is the resolved config
 * username, percent-encoded so delimiters cannot forge the URL; no
 * password parameter exists by design, and callers must not log the
 * result (it can carry the username).
 */
export function socksUrl(s: TuberStatus, user: string): string | undefined {
  if (s.type !== "dynamic") return undefined;
  const a = localAddress(s);
  if (!a) return undefined;
  return user ? `socks5://${encodeURIComponent(user)}@${a}` : `socks5://${a}`;
}
