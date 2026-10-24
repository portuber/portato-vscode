import * as vscode from "vscode";
import { AskedPrompts, promptKey } from "./promptKeys";
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

  /** Tree action: re-ask even if this exact pending state was dismissed. */
  promptFor(s: TuberStatus): void {
    const p = promptKey(s);
    if (!p) {
      // The tree item was built before a redial cleared the pending flag;
      // the daemon re-sets it on the next dial cycle.
      void vscode.window.showInformationMessage(
        `portato: ${s.name}: no prompt is pending -- waiting for the next dial to re-offer it`,
      );
      return;
    }
    if (this.inFlight.has(p.key)) {
      // A dialog for this exact key is already open. VS Code moves action
      // toasts into the notification center after their timeout, so the user
      // clicking here may not see it -- point at it instead of going silent.
      void vscode.window.showInformationMessage(
        `portato: ${s.name}: a prompt is already open -- see the notification center`,
        "Show notifications",
      ).then((action) => {
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
        const review = "Review...";
        const action = await vscode.window.showWarningMessage(
          `Unknown SSH host key for ${p.detail} (tunnel ${s.name})`,
          review,
        );
        if (action !== review) return;
        const ok = await confirmHostKey(p.detail, p.fingerprint);
        if (ok) await this.deps.submit(s.name, p.kind, undefined);
        return;
      }
      const label =
        p.kind === "passphrase" ? "Enter passphrase" : "Enter password";
      // An empty secret is legitimate (e.g. a key with an empty passphrase):
      // the input box rejects it to prevent accidents, but the explicit
      // action sends "" through the same submit path.
      const sendEmpty =
        p.kind === "passphrase" ? "Send empty passphrase" : "Send empty password";
      const action = await vscode.window.showInformationMessage(
        this.messageFor(s, p),
        label,
        sendEmpty,
      );
      if (action === sendEmpty) {
        await this.deps.submit(s.name, p.kind, "");
        return;
      }
      if (action !== label) return; // dismissed -- the tree action re-opens
      const value =
        p.kind === "passphrase"
          ? await askPassphrase(s, p.attempts, p.detail)
          : await askPassword(s, p.attempts, p.detail);
      if (value === undefined) return; // cancelled
      await this.deps.submit(s.name, p.kind, value);
    } catch (e) {
      // Network/server failure: allow a re-ask instead of wedging the dedupe.
      this.asked.delete(key);
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`portato: ${s.name}: ${msg}`);
    } finally {
      this.inFlight.delete(key);
    }
  }

  private messageFor(
    s: TuberStatus,
    p: { kind: PromptKind; detail: string; attempts: number },
  ): string {
    const hint = p.attempts > 0 ? " (previous attempt failed)" : "";
    if (p.kind === "passphrase") {
      return `Passphrase needed for ${s.name} -- key ${p.detail}${hint}`;
    }
    return `Password needed for ${s.name} -- ${p.detail}${hint}`;
  }
}

export async function askPassphrase(
  s: TuberStatus,
  attempts: number,
  identity: string,
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: `Identity passphrase -- tunnel ${s.name}`,
    prompt: attempts > 0 ? "Wrong passphrase -- try again" : `Passphrase for ${identity}`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.length > 0 ? undefined : "Empty passphrase"),
  });
}

export async function askPassword(s: TuberStatus, attempts: number, account: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: `Password -- tunnel ${s.name}`,
    prompt: attempts > 0 ? "Wrong password -- try again" : `Password for ${account}`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.length > 0 ? undefined : "Empty password"),
  });
}

export async function confirmHostKey(host: string, fingerprint: string | undefined): Promise<boolean> {
  const pick = await vscode.window.showWarningMessage(
    `Unknown SSH host key for ${host}`,
    { modal: true, detail: fingerprint ? `Fingerprint: ${fingerprint}` : undefined },
    "Accept",
  );
  return pick === "Accept";
}
