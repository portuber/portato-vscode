import * as vscode from "vscode";
import { pendingPrompt, type TuberStatus } from "./types";

// Interactive prompts for a blocked tuber. UX rules:
//   - prompts are offered via a notification with an action, never as an
//     unsolicited input box
//   - dedupe by (tuber, pending kind, attempts) so one pending state asks once
//   - attempts > 0 shows a "wrong passphrase/password" hint
//   - host-key accept is offered as a notification, modal only when the user
//     asks to review (host + fingerprint); the POST body is empty -- the
//     daemon appends pending_host_line itself

export type PromptKind = "hostkey" | "passphrase" | "password";

export interface PromptCoordinatorDeps {
  /** Send the answer to the daemon; reject propagates to the user. */
  submit(name: string, kind: PromptKind, value: string | undefined): Promise<void>;
}

export class PromptCoordinator {
  private readonly asked = new Set<string>();

  constructor(private readonly deps: PromptCoordinatorDeps) {}

  key(s: TuberStatus): string | null {
    const p = pendingPrompt(s);
    if (!p) return null;
    return `${s.name}:${p.kind}:${p.attempts}`;
  }

  /** Drop stale entries: a tuber that no longer has this exact pending state. */
  sync(statuses: TuberStatus[]): void {
    const live = new Set<string>();
    for (const s of statuses) {
      const k = this.key(s);
      if (k) live.add(k);
    }
    for (const k of this.asked) {
      if (!live.has(k)) this.asked.delete(k);
    }
  }

  offer(s: TuberStatus): void {
    const p = pendingPrompt(s);
    if (!p) return;
    const k = this.key(s);
    if (!k || this.asked.has(k)) return;
    this.asked.add(k);
    void this.ask(s, p, k);
  }

  private async ask(
    s: TuberStatus,
    p: { kind: PromptKind; detail: string; fingerprint?: string; attempts: number },
    k: string,
  ): Promise<void> {
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
      const action = await vscode.window.showInformationMessage(
        this.messageFor(s, p),
        label,
      );
      if (action !== label) return; // dismissed -- a later attempts bump re-asks
      const value =
        p.kind === "passphrase"
          ? await askPassphrase(p.attempts)
          : await askPassword(p.attempts, p.detail);
      if (value === undefined) return; // cancelled
      await this.deps.submit(s.name, p.kind, value);
    } catch (e) {
      // Network/server failure: allow a re-ask instead of wedging the dedupe.
      this.asked.delete(k);
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`portato: ${s.name}: ${msg}`);
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

export async function askPassphrase(attempts: number): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: attempts > 0 ? "Wrong passphrase -- try again" : "Identity passphrase",
    password: true,
    ignoreFocusOut: true,
  });
}

export async function askPassword(attempts: number, account: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: attempts > 0 ? "Wrong password -- try again" : `Password for ${account}`,
    password: true,
    ignoreFocusOut: true,
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
