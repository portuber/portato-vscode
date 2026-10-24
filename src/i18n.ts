// Shared localization plumbing for vscode-free modules. Pure modules take a
// translator parameter (default identityT) so unit tests keep running
// without VS Code while the real call sites pass vscode.l10n.t.

/** Localizer signature, vscode.l10n.t-compatible. */
export type Translate = (msg: string, ...args: (string | number | boolean)[]) => string;

/**
 * Default localizer: returns the message with {0}/{1}/... substituted the
 * way vscode.l10n.t does. A placeholder without a matching argument stays
 * literal ({1}), mirroring the real behavior -- substituting "" instead
 * would hide argument-count bugs from the tests.
 */
export const identityT: Translate = (msg, ...args) =>
  args.length === 0
    ? msg
    : msg.replace(/\{(\d+)\}/g, (m, d) => {
        const i = Number(d);
        return i < args.length ? String(args[i]) : m;
      });
