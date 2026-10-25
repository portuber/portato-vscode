// Pure mapping from daemon HTTP errors to user-facing plans. The daemon
// answers 404 for a tuber unknown to it (the config changed outside VS Code:
// the tree item is stale) and 409 when a prompt submit races the dial moving
// on ("no pending host key" / "no identity to store a passphrase for" /
// "no SSH account to store a password for", internal/daemon/server.go).
// Raw error texts are daemon-side English; these plans replace the common
// codes with localized, actionable messages. vscode-free: the caller injects
// the localizer (see i18n.ts).

import { httpStatusOf } from "./daemonClient";
import { identityT, type Translate } from "./i18n";

export interface TunnelErrorPlan {
  message: string;
  /**
   * 404: the tree item the action ran on no longer exists daemon-side.
   * The caller should re-fetch statuses so the tree heals immediately
   * instead of waiting for the next SSE signal.
   */
  staleItem: boolean;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Error surface for actions bound to a tree item (enable/disable/restart/
 * delete/move). 404 means the item is stale; everything else keeps the
 * daemon's message (it is already specific: "unknown tuber ...",
 * "persist config: ...").
 */
export function planTunnelError(
  e: unknown,
  name: string,
  t: Translate = identityT,
): TunnelErrorPlan {
  if (httpStatusOf(e) === 404) {
    return {
      message: t(
        "portato: {0}: tunnel not found -- the config changed outside VS Code, refreshing",
        name,
      ),
      staleItem: true,
    };
  }
  return { message: t("portato: {0}: {1}", name, errText(e)), staleItem: false };
}

/**
 * Error surface for a prompt answer (passphrase/password/accept-host).
 * 409 means the daemon is no longer blocked on this input -- a redial or a
 * config change cleared the pending state between the offer and the answer.
 */
export function planPromptError(
  e: unknown,
  name: string,
  t: Translate = identityT,
): TunnelErrorPlan {
  if (httpStatusOf(e) === 409) {
    return {
      message: t(
        "portato: {0}: no prompt is pending anymore -- the dial moved on",
        name,
      ),
      staleItem: false,
    };
  }
  return planTunnelError(e, name, t);
}

/**
 * Error surface for the add/edit form submit. 409 is the daemon's
 * duplicate-name rejection on POST /tubers ONLY: a rename onto an
 * existing name fails daemon-side config validation and comes back as a
 * 400 (raw text). A raw daemon-side English string helps nobody.
 */
export function planFormError(
  e: unknown,
  t: Translate = identityT,
): string {
  if (httpStatusOf(e) === 409) {
    return t("portato: a tunnel with this name already exists");
  }
  return errText(e);
}

/**
 * Gating for the persistent-401 episode. A single 401 that survives the
 * client's internal re-read+retry can be a daemon-restart race; a 401 on
 * consecutive refresh cycles (each cycle builds a FRESH client with a
 * freshly-read token) means the token file genuinely mismatches the daemon
 * (e.g. a socketPath override pointing at a socket whose token lives
 * elsewhere). The message shows once per episode; a successful fetch ends
 * the episode.
 */
export class AuthEpisode {
  private streak = 0;
  private shown = false;

  /** Record a failed (401) refresh; true when the mismatch message should show. */
  record401(): boolean {
    this.streak++;
    if (this.streak < 2 || this.shown) return false;
    this.shown = true;
    return true;
  }

  /** Record a successful refresh; resets the episode. */
  recordSuccess(): void {
    this.streak = 0;
    this.shown = false;
  }
}
