// Poll policy for the logs view, kept free of vscode so it is
// unit-testable.
//
// VS Code offers no visibility signal for output channels (the interface is
// append/replace/clear/show/hide only; channels are not text editors and
// never appear in workspace.textDocuments or window.tabGroups), so "shown
// at least once" is a one-way ratchet: after the user opens the channel
// once, polling runs for the rest of the session even if the panel is
// closed again. That still removes the expensive case -- the channel that
// is never opened, which would otherwise fetch the full ~400 KB ring every
// 2 s forever -- while costing nothing in fidelity.

export const BASE_POLL_MS = 2000;
/** Backed-off cadence for a ring that has been quiet for a while. */
export const BACKED_OFF_POLL_MS = 10000;
/** Consecutive fully-quiet polls before backing off. */
const IDLE_TICKS_TO_BACKOFF = 5;

/** Poll only while a daemon connection exists AND after the first show(). */
export function shouldPoll(connected: boolean, everShown: boolean): boolean {
  return connected && everShown;
}

/**
 * Delay before the next poll, given the number of consecutive no-change
 * polls so far. The counter is owned by the caller (LogsView): a poll that
 * produced entries or a gap resets it, and so do show() and a stop()/start()
 * cycle; a FAILED fetch leaves it untouched -- a network hiccup is not
 * evidence of a quiet ring.
 */
export function nextDelayMs(idleTicks: number): number {
  return idleTicks >= IDLE_TICKS_TO_BACKOFF ? BACKED_OFF_POLL_MS : BASE_POLL_MS;
}
