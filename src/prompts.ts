import * as vscode from "vscode";
import { planPromptError } from "./errors";
import { AskedPrompts, promptKey } from "./promptKeys";
import { promptForPlan } from "./promptForPlan";
import type { PromptKind, TuberStatus } from "./types";

// Interactive prompts for a blocked tuber. UX rules:
//   - prompts are offered via a notification with an action, never as an
//     unsolicited input box
//   - dedupe lives in promptKeys.ts: host-key by (tuber, fingerprint) so a
//     redial does not re-notify; passphrase/password by (tuber, kind,
//     attempts) so a wrong answer re-asks
//   - attempts > 0 shows a "wrong passphrase/password" hint
//   - a dismissed notification never re-asks by itself (the dial blocks
//     without bumping attempts) -- the tree item offers an explicit
//     "Answer prompt" action that bypasses the dedupe via promptFor()
//   - host-key accept is a notification, modal only when the user asks to
//     review (host + fingerprint); the POST body is empty -- the daemon
//     appends pending_host_line itself
//   - an empty secret is legitimate but must be a confirmed choice: the
//     toast carries one action, the input box accepts an empty answer, and
//     an explicit modal confirms sending it (Cancel re-opens the box)

export interface PromptCoordinatorDeps {
  /** Send the answer to the daemon; reject propagates to the user. */
  submit(name: string, kind: PromptKind, value: string | undefined): Promise<void>;
}

export class PromptCoordinator {
  private readonly asked = new AskedPrompts();
  /** Keys with a dialog currently open: offer/promptFor must not stack a second one. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: PromptCoordinatorDeps) {}

  key(s: TuberStatus): string | null {
    return promptKey(s)?.key ?? null;
  }

  /** Drop stale entries; see AskedPrompts.prune for the host-key rules. */
  sync(statuses: TuberStatus[]): void {
    this.asked.prune(statuses);
  }

  offer(s: TuberStatus): void {
    const p = promptKey(s);
    if (!p || this.asked.has(p.key) || this.inFlight.has(p.key)) return;
    this.asked.add(p.key, { name: s.name, kind: p.kind });
    void this.ask(s, p.key);
  }

  /**
   * Tree action: re-ask even if this exact pending state was dismissed.
   * rememberedHost = the controller still holds a pending host key for this
   * tuber (it is pruned as soon as the tuber leaves `connecting`), which
   * distinguishes the post-accept handshake window from "nothing pending".
   */
  promptFor(s: TuberStatus, rememberedHost = false): void {
    const plan = promptForPlan(s, rememberedHost);
    if (plan === "handshake") {
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          "portato: {0}: handshake in progress -- waiting for the daemon to re-offer the prompt",
          s.name,
        ),
      );
      return;
    }
    const p = promptKey(s);
    if (!p) {
      // The tree item was built before a redial cleared the pending flag;
      // the daemon re-sets it on the next dial cycle.
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          "portato: {0}: no prompt is pending -- waiting for the next dial to re-offer it",
          s.name,
        ),
      );
      return;
    }
    if (this.inFlight.has(p.key)) {
      // A dialog for this exact key is already open. VS Code moves action
      // toasts into the notification center after their timeout, so the user
      // clicking here may not see it -- point at it instead of going silent.
      void vscode.window
        .showInformationMessage(
          vscode.l10n.t(
            "portato: {0}: a prompt is already open -- see the notification center",
            s.name,
          ),
          vscode.l10n.t("Show notifications"),
        )
        .then((action) => {
          if (action !== undefined) {
            void vscode.commands.executeCommand("notifications.showList");
          }
        });
      return;
    }
    this.asked.delete(p.key);
    this.asked.add(p.key, { name: s.name, kind: p.kind });
    void this.ask(s, p.key);
  }

  private async ask(s: TuberStatus, key: string): Promise<void> {
    const p = promptKey(s);
    if (!p) return;
    this.inFlight.add(key);
    try {
      if (p.kind === "hostkey") {
        // Offer first, modal only on demand: a background SSE event must not
        // block the window with an unrequested modal.
        const review = vscode.l10n.t("Review...");
        const action = await vscode.window.showWarningMessage(
          vscode.l10n.t("Unknown SSH host key for {0} (tunnel {1})", p.detail, s.name),
          review,
        );
        if (action !== review) return;
        const ok = await confirmHostKey(p.detail, p.fingerprint);
        if (ok) await this.deps.submit(s.name, p.kind, undefined);
        return;
      }
      const label =
        p.kind === "passphrase"
          ? vscode.l10n.t("Enter passphrase")
          : vscode.l10n.t("Enter password");
      // One action: an empty secret must be a deliberate, confirmed choice,
      // not a toast button that sits next to the main one.
      const action = await vscode.window.showInformationMessage(
        this.messageFor(s, p),
        label,
      );
      if (action !== label) return; // dismissed -- the tree action re-opens
      // An empty answer is legitimate (e.g. a key with an empty passphrase);
      // confirm it with a modal, and let Cancel fall back to the input box
      // instead of counting as a dismissal (the dial blocks without bumping
      // attempts, so nothing re-asks on its own).
      for (;;) {
        const value =
          p.kind === "passphrase"
            ? await askPassphrase(s, p.attempts, p.detail)
            : await askPassword(s, p.attempts, p.detail);
        if (value === undefined) return; // Esc in the box is the real cancel
        if (value !== "") {
          await this.deps.submit(s.name, p.kind, value);
          return;
        }
        const sendEmpty =
          p.kind === "passphrase"
            ? vscode.l10n.t("Send empty passphrase")
            : vscode.l10n.t("Send empty password");
        // Two separate keys instead of interpolating p.kind: the enum value
        // would land mid-sentence and no locale can inflect it.
        const message =
          p.kind === "passphrase"
            ? vscode.l10n.t("Send an empty passphrase for {0}?", s.name)
            : vscode.l10n.t("Send an empty password for {0}?", s.name);
        const pick = await vscode.window.showWarningMessage(
          message,
          {
            modal: true,
            detail: vscode.l10n.t(
              "The tunnel treats an empty answer as an explicit empty secret.",
            ),
          },
          sendEmpty,
        );
        if (pick === sendEmpty) {
          await this.deps.submit(s.name, p.kind, "");
          return;
        }
      }
    } catch (e) {
      // Network/server failure: allow a re-ask instead of wedging the dedupe.
      this.asked.delete(key);
      void vscode.window.showErrorMessage(
        planPromptError(e, s.name, vscode.l10n.t).message,
      );
    } finally {
      this.inFlight.delete(key);
    }
  }

  private messageFor(
    s: TuberStatus,
    p: { kind: PromptKind; detail: string; attempts: number },
  ): string {
    const hint =
      p.attempts > 0 ? vscode.l10n.t(" (previous attempt failed)") : "";
    if (p.kind === "passphrase") {
      return vscode.l10n.t("Passphrase needed for {0} -- key {1}{2}", s.name, p.detail, hint);
    }
    return vscode.l10n.t("Password needed for {0} -- {1}{2}", s.name, p.detail, hint);
  }
}

export async function askPassphrase(
  s: TuberStatus,
  attempts: number,
  identity: string,
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: vscode.l10n.t("Identity passphrase -- tunnel {0}", s.name),
    prompt:
      attempts > 0
        ? vscode.l10n.t("Wrong passphrase -- try again")
        : vscode.l10n.t("Passphrase for {0}", identity),
    password: true,
    ignoreFocusOut: true,
    // No min-length validation: an empty answer is handled as an explicit
    // confirmation flow in ask(), not rejected here.
  });
}

export async function askPassword(s: TuberStatus, attempts: number, account: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: vscode.l10n.t("Password -- tunnel {0}", s.name),
    prompt:
      attempts > 0
        ? vscode.l10n.t("Wrong password -- try again")
        : vscode.l10n.t("Password for {0}", account),
    password: true,
    ignoreFocusOut: true,
  });
}

export async function confirmHostKey(host: string, fingerprint: string | undefined): Promise<boolean> {
  const accept = vscode.l10n.t("Accept");
  const pick = await vscode.window.showWarningMessage(
    vscode.l10n.t("Unknown SSH host key for {0}", host),
    {
      modal: true,
      detail: fingerprint
        ? vscode.l10n.t("Fingerprint: {0}", fingerprint)
        : undefined,
    },
    accept,
  );
  return pick === accept;
}
