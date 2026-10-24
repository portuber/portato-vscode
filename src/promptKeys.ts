// Prompt dedupe state, kept free of vscode so it is unit-testable.
//
// Key facts driving the shape (internal/forward/tuber.go):
//   - every redial starts with clearPendingHost, so a host-key prompt
//     FLAPS between snapshots: error+pending_host -> connecting (no pending)
//     -> error+pending_host. The dedupe key must survive that window or the
//     user gets a new notification on every backoff cycle.
//   - passphrase/password pending flags are cleared on dial failure, so
//     their key (name:kind:attempts) is live only while the exact pending
//     state is present; the attempts counter makes a wrong-answer re-ask a
//     new key.
//   - a resolved prompt is pruned when the tuber leaves the prompting states
//     (connected / off / gone) -- never on the redial window alone.

import { pendingPrompt, type PromptKind, type TuberStatus } from "./types";

export interface AskedEntry {
  readonly name: string;
  readonly kind: PromptKind;
}

/** Stable across redials: fingerprint, not attempts. */
export function promptKey(
  s: TuberStatus,
): { key: string; kind: PromptKind; detail: string; fingerprint?: string; attempts: number } | null {
  const p = pendingPrompt(s);
  if (!p) return null;
  if (p.kind === "hostkey") {
    return { ...p, key: `${s.name}:hostkey:${p.fingerprint ?? ""}` };
  }
  return { ...p, key: `${s.name}:${p.kind}:${p.attempts}` };
}

export class AskedPrompts {
  private readonly entries = new Map<string, AskedEntry>();

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Test hook: number of live dedupe entries. */
  size(): number {
    return this.entries.size;
  }

  add(key: string, entry: AskedEntry): void {
    this.entries.set(key, entry);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /**
   * Drop keys whose pending state is gone. Host-key entries survive the
   * redial window (pending_host cleared at dial start, back on failure) and
   * are dropped only when the tuber reaches a terminal state or vanishes.
   */
  prune(statuses: TuberStatus[]): void {
    const byName = new Map(statuses.map((s) => [s.name, s]));
    for (const [key, entry] of this.entries) {
      const st = byName.get(entry.name);
      if (!st) {
        this.entries.delete(key);
        continue;
      }
      if (entry.kind === "hostkey") {
        if (st.state === "connected" || st.state === "off") this.entries.delete(key);
        continue;
      }
      if (promptKey(st)?.key !== key) this.entries.delete(key);
    }
  }
}
