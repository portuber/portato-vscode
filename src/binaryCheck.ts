import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";

// Whether the configured portato binary can execute on this machine. Pure
// existence + X_OK checks -- never an execution: running the CLI belongs to
// the lifecycle module, and a liveness probe must not have side effects.
//
// A bare name resolves against the given PATH (a GUI-launched VS Code may
// see a different PATH than a shell); anything containing a separator is
// taken verbatim, matching how spawn() would resolve it.

export async function isBinaryAvailable(
  binary: string,
  envPath: string,
): Promise<boolean> {
  const candidates = binary.includes("/")
    ? [binary]
    : envPath
        .split(":")
        .filter((d) => d !== "")
        .map((d) => join(d, binary));
  for (const c of candidates) {
    try {
      await access(c, fsConstants.X_OK);
      return true;
    } catch {
      // not here -- try the next PATH entry
    }
  }
  return false;
}
