import * as vscode from "vscode";
import { pendingPrompt, type TuberStatus } from "./types";

// Interactive prompts for a blocked tuber. UX rules:
//   - prompts are offered via a notification with an action, never as an
//     unsolicited input box
//   - dedupe by (tuber, pending kind, attempts) so one pending state asks once
//   - attempts > 0 shows a "wrong passphrase/password" hint
//   - host-key accept is a modal showing host + fingerprint; the POST body is
//     empty — the daemon appends pending_host_line itself
export class PromptCoordinator {
  private readonly asked = new Set<string>();

  key(s: TuberStatus): string | null {
    const p = pendingPrompt(s);
    if (!p) return null;
    return `${s.name}:${p.kind}:${p.attempts}`;
  }

  offer(s: TuberStatus): void {
    void s;
    throw new Error("not implemented (part 1 MVP)");
  }
}

export async function askPassphrase(attempts: number): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: attempts > 0 ? "Wrong passphrase — try again" : "Identity passphrase",
    password: true,
    ignoreFocusOut: true,
  });
}

export async function askPassword(attempts: number, account: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: attempts > 0 ? "Wrong password — try again" : `Password for ${account}`,
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
