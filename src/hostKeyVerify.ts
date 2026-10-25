// Pure decision behind the accept-host submit (verdict D-3 of the 0.1.2
// hotfix). The TOFU modal shows the (host, fingerprint) pair from the
// status the notification was built from, but accept-host POSTs an empty
// body: the daemon appends whatever key is pending AT THAT MOMENT. A
// re-dial may have swapped the pending key while the user stared at the
// modal, so the pair captured BEFORE the modal must be re-checked against
// a fresh status right before the POST.

import type { TuberStatus } from "./types";

/** The pair exactly as shown to the user (promptKey's detail/fingerprint). */
export interface ShownHostKey {
  readonly host: string;
  readonly fingerprint: string | undefined;
}

/**
 * May the accept-host POST proceed for the shown pair, given the tuber's
 * fresh status? True only when the pending host AND fingerprint still
 * match what the user accepted. A missing fingerprint on either side
 * cannot be compared: only both-missing counts as unchanged (the daemon
 * omits the field only when it has none to show). False means: send
 * nothing and drop the flow silently -- the (tuber, fingerprint) dedupe
 * key in promptKeys raises a fresh notification for the new key through
 * the normal offer path.
 *
 * NOTE: a small race window remains between the caller's re-fetch and the
 * POST; it can only be closed by a daemon API that accepts the expected
 * fingerprint with the request (recorded as a portato daemon follow-up).
 */
export function acceptStillPending(
  shown: ShownHostKey,
  fresh: TuberStatus | undefined,
): boolean {
  if (!fresh || fresh.pending_host !== shown.host) return false;
  return (fresh.pending_fingerprint ?? "") === (shown.fingerprint ?? "");
}
