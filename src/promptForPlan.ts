// What promptFor() should do for a tuber, kept free of vscode so it is
// unit-testable. The controller remembers seen host keys in pendingHosts
// (updatePendingHosts): the daemon clears `pending_host` at the start of
// every redial, so between accepting the key and the next TOFU rejection
// there is a `connecting` window where no pending flag is live yet the
// prompt is still outstanding.

import { pendingPrompt, type TuberStatus } from "./types";

export type PromptForPlan =
  // A pending prompt exists -- offer the dialog.
  | "prompt"
  // Post-accept `connecting` window: the key was accepted, the daemon is
  // redialing, nothing to answer right now.
  | "handshake"
  // No prompt and no remembered host key -- nothing will come on its own.
  | "none";

export function promptForPlan(
  s: TuberStatus,
  rememberedHost: boolean,
): PromptForPlan {
  if (pendingPrompt(s) !== null) return "prompt";
  // Defensive about `rememberedHost`: updatePendingHosts prunes the entry as
  // soon as the tuber leaves `connecting` without a pending host, so a stale
  // flag reaching this branch is a bug -- still gate on the state.
  if (rememberedHost && s.state === "connecting") return "handshake";
  return "none";
}
