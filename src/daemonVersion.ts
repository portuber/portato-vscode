// Daemon version surfacing. /healthz has carried a version string since
// daemon v1.11.0; older daemons omit the field. The consult verdict is
// warning-only: a missing or odd version never blocks operation, because
// "no field" only means "older than 1.11.0", not "broken".
//
// Parsing is deliberately strict -- exactly three numeric components with an
// optional leading "v". Anything else ("dev" builds, a pre-release suffix
// like "1.12.0-beta.1", a short "1.2") classifies as "unrecognized":
// warning-only like everything here, but with its own honest message,
// because blessing a numeric prefix of a build we cannot vouch for would
// turn the check into a guess. "unknown" is reserved for a field that is
// missing or empty.

export const MIN_DAEMON_VERSION = "1.11.0";

export type VersionVerdict = "ok" | "belowMin" | "unknown" | "unrecognized";

/**
 * Numeric triad compare (-1 | 0 | 1). Callers must feed it strings that
 * match the strict shape above; classifyVersion guards the gate, and a
 * missing component simply counts as 0 (so "1.2" equals "1.2.0").
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/**
 * ok / belowMin for strict triads; "unknown" when the field is absent or
 * empty (a daemon older than 1.11.0); "unrecognized" when a value IS
 * present but unparseable ("dev" builds, pre-release suffixes) -- those
 * get their own, honest message upstream.
 */
export function classifyVersion(version: string | undefined): VersionVerdict {
  if (!version) return "unknown";
  if (!/^v?\d+\.\d+\.\d+$/.test(version)) return "unrecognized";
  return compareVersions(version, MIN_DAEMON_VERSION) < 0 ? "belowMin" : "ok";
}
