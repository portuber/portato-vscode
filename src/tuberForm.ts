import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import type { DaemonClient } from "./daemonClient";
import type { ConfigTuber } from "./types";
import {
  buildTuberBody,
  prefillFrom,
  tuberChanged,
  validateFields,
  type TuberFormFields,
} from "./tuberFormFields";

// Add/edit tunnel as a single webview form. Contract facts:
//   - PUT /tubers/{name} replaces the tuber wholesale and renames when the
//     body's name differs from the path, so the submit re-reads GET /config
//     and merges the form over the FRESH raw tuber (unknown daemon fields
//     survive; see tuberFormFields.buildTuberBody).
//   - A PUT that would change nothing is skipped (the daemon's prepare()
//     normalizes type/local, so a naive compare would spam YAML rewrites).
//   - Secrets never enter the webview: the daemon's socks5_password is a
//     set/unset flag here; a typed value sets it, the checkbox clears it,
//     empty means "keep".
// Security: one nonce-guarded inline script, CSP default-src 'none', every
// prefill value HTML-escaped; the form talks to the extension exclusively
// via postMessage. Strings live in S below so part 2's l10n pass can swap
// the table for vscode.l10n.t in one place.

export const S = {
  addTitle: "Add tunnel",
  editTitle: (name: string) => `Edit tunnel: ${name}`,
  errNotFound: (name: string) => `portato: tunnel ${name} not found in the daemon config`,
  errNoClient: "portato: daemon not connected",
  errConflictTitle: "The daemon's config changed since this form opened",
  errConflictDetail: "Reload the form to see the current values, or overwrite them with yours.",
  actionReload: "Reload form",
  actionOverwrite: "Overwrite",
  msgAdded: (name: string) => `portato: tunnel ${name} added`,
  msgUpdated: (name: string) => `portato: tunnel ${name} updated`,
  msgUnchanged: "portato: nothing to save -- the form matches the daemon config",
  msgReloaded: "portato: config reloaded",
  labelName: "Name",
  labelType: "Type",
  labelLocal: "Local address",
  labelRemote: "Remote address",
  labelSsh: "SSH target",
  labelIdentity: "Identity",
  labelEnabled: "Enabled",
  labelTags: "Tags (comma separated)",
  labelJump: "Jump host",
  labelPasswordAuth: "SSH password auth",
  paInherit: "Inherit (defaults)",
  paOn: "On",
  paOff: "Off",
  labelSocks5User: "SOCKS5 user",
  labelSocks5Password: "SOCKS5 password",
  socksSetHint: "A password is currently set. Type to replace it.",
  socksClear: "Clear stored password",
  actionSave: "Save",
  actionCancel: "Cancel",
};

export interface TuberFormDeps {
  getClient(): DaemonClient | undefined;
  refresh(): Promise<unknown>;
}

type RawTuber = Record<string, unknown>;

interface FormState {
  mode: "add" | "edit";
  /** Path segment for PUT; set in edit mode only. */
  originalName?: string;
  /** Raw snapshot at open/conflict-reload time, for the conflict check. */
  snapshot?: RawTuber;
  /** A submit is being processed; further submits from this panel are ignored. */
  busy: boolean;
}

export class TuberFormController {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly deps: TuberFormDeps) {}

  async openAdd(): Promise<void> {
    if (!this.deps.getClient()) {
      void vscode.window.showErrorMessage(S.errNoClient);
      return;
    }
    this.openPanel({ mode: "add", busy: false }, S.addTitle, prefillFrom(undefined), false);
  }

  async openEdit(name: string): Promise<void> {
    const client = this.deps.getClient();
    if (!client) {
      void vscode.window.showErrorMessage(S.errNoClient);
      return;
    }
    let raw: RawTuber | undefined;
    try {
      const cfg = await client.config();
      raw = cfg.tubers.find((t) => t.name === name) as unknown as
        | RawTuber
        | undefined;
    } catch (e) {
      void vscode.window.showErrorMessage(`portato: ${name}: ${errText(e)}`);
      return;
    }
    if (!raw) {
      void vscode.window.showErrorMessage(S.errNotFound(name));
      return;
    }
    this.openPanel(
      { mode: "edit", originalName: name, snapshot: { ...raw }, busy: false },
      S.editTitle(name),
      prefillFrom(raw),
      raw.socks5_password !== "",
    );
  }

  private openPanel(state: FormState, title: string, prefill: TuberFormFields, socksSet: boolean): void {
    if (this.panel) this.panel.dispose();
    const panel = vscode.window.createWebviewPanel(
      "portatoTunnelForm",
      title,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel = panel;
    panel.webview.html = buildFormHtml(prefill, socksSet);
    // FormState lives in this closure, per panel: a replaced (disposed)
    // panel must not leak its mode/snapshot/busy into the next one, and an
    // in-flight submit of the old panel must not act on the new panel's
    // state.
    panel.webview.onDidReceiveMessage(
      (m) => void this.handleMessage(m, panel, state),
      undefined,
      [],
    );
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
    });
  }

  /** Drop messages for panels that were closed/replaced mid-flight. */
  private postTo(panel: vscode.WebviewPanel, message: unknown): void {
    if (this.panel !== panel) return;
    void panel.webview.postMessage(message);
  }

  private async handleMessage(
    m: unknown,
    panel: vscode.WebviewPanel,
    state: FormState,
  ): Promise<void> {
    if (typeof m !== "object" || m === null) return;
    const msg = m as { type?: string; fields?: TuberFormFields };
    if (msg.type === "cancel") {
      panel.dispose();
      return;
    }
    if (msg.type !== "submit" || !msg.fields || state.busy) return;

    const client = this.deps.getClient();
    if (!client) {
      this.postTo(panel, { type: "error", message: S.errNoClient });
      return;
    }
    const invalid = validateFields(msg.fields);
    if (invalid) {
      this.postTo(panel, { type: "error", message: invalid });
      return;
    }

    state.busy = true;
    let mutated = false;
    let toast: string | undefined;
    try {
      if (state.mode === "add") {
        await client.addTuber(buildTuberBody(undefined, msg.fields) as unknown as ConfigTuber);
        mutated = true;
        toast = S.msgAdded(msg.fields.name.trim());
      } else {
        // Edit: re-read the config for the conflict check and as the merge base.
        const originalName = state.originalName!;
        const cfg = await client.config();
        const fresh = cfg.tubers.find((t) => t.name === originalName) as unknown as
          | RawTuber
          | undefined;
        if (!fresh) {
          this.postTo(panel, { type: "error", message: S.errNotFound(originalName) });
          return;
        }
        if (state.snapshot && tuberChanged(fresh, state.snapshot)) {
          const pick = await vscode.window.showWarningMessage(
            S.errConflictTitle,
            { modal: true, detail: S.errConflictDetail },
            S.actionReload,
            S.actionOverwrite,
          );
          if (pick === undefined) {
            // Modal cancelled -- keep editing. The submit disabled Save, so
            // re-enable it before returning (any early return after a submit
            // must either dispose the panel or post error/reload/idle).
            this.postTo(panel, { type: "idle" });
            return;
          }
          if (pick === S.actionReload) {
            state.snapshot = { ...fresh };
            this.postTo(panel, {
              type: "reload",
              fields: prefillFrom(fresh),
              socksSet: fresh.socks5_password !== "",
            });
            return;
          }
          // Overwrite: accept the daemon-side drift as the new snapshot so
          // this save (and the next one) stops flagging the same diff.
          state.snapshot = { ...fresh };
        }
        const body = buildTuberBody(fresh, msg.fields);
        if (!tuberChanged(body, fresh)) {
          toast = S.msgUnchanged;
        } else {
          await client.updateTuber(originalName, body as unknown as ConfigTuber);
          mutated = true;
          toast = S.msgUpdated(msg.fields.name.trim());
        }
      }
      panel.dispose();
      if (toast !== undefined) void vscode.window.showInformationMessage(toast);
    } catch (e) {
      // Keep the form open so the user can fix the input and retry.
      this.postTo(panel, { type: "error", message: errText(e) });
    } finally {
      state.busy = false;
    }
    // Best-effort only: the panel is closed by now, so a refresh failure
    // must not surface as an error on a disposed webview.
    if (mutated) {
      try {
        await this.deps.refresh();
      } catch {
        /* the next SSE signal / refresh repairs the tree */
      }
    }
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildFormHtml(
  prefill: TuberFormFields,
  socksSet: boolean,
): string {
  const nonce = cryptoRandom();
  const sel = (want: string, got: string) => (want === got ? " selected" : "");
  const ck = (on: boolean) => (on ? " checked" : "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>portato tunnel</title>
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 0 16px 16px; }
.row { margin: 10px 0; }
.row label { display: block; margin-bottom: 3px; color: var(--vscode-foreground); }
.row input[type=text], .row input[type=password], .row select {
  width: 100%; box-sizing: border-box; padding: 4px 6px;
  color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
}
.row.inline label { display: inline; margin-left: 6px; }
.hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin: 2px 0 0; }
#err { color: var(--vscode-errorForeground); margin: 8px 0; min-height: 1em; }
.actions { margin-top: 16px; display: flex; gap: 8px; }
button { padding: 5px 14px; }
</style>
</head>
<body>
<form id="form">
  <div class="row"><label for="f-name">${S.labelName}</label>
    <input type="text" id="f-name" value="${esc(prefill.name)}"></div>
  <div class="row"><label for="f-type">${S.labelType}</label>
    <select id="f-type">
      <option value="local"${sel("local", prefill.type)}>local</option>
      <option value="remote"${sel("remote", prefill.type)}>remote</option>
      <option value="dynamic"${sel("dynamic", prefill.type)}>dynamic</option>
    </select></div>
  <div class="row"><label for="f-local">${S.labelLocal}</label>
    <input type="text" id="f-local" value="${esc(prefill.local)}"></div>
  <div class="row"><label for="f-remote">${S.labelRemote}</label>
    <input type="text" id="f-remote" value="${esc(prefill.remote)}"></div>
  <div class="row"><label for="f-ssh">${S.labelSsh}</label>
    <input type="text" id="f-ssh" value="${esc(prefill.ssh)}" placeholder="user@host:port"></div>
  <div class="row"><label for="f-identity">${S.labelIdentity}</label>
    <input type="text" id="f-identity" value="${esc(prefill.identity)}" placeholder="~/.ssh/id_ed25519"></div>
  <div class="row inline"><input type="checkbox" id="f-enabled"${ck(prefill.enabled)}>
    <label for="f-enabled">${S.labelEnabled}</label></div>
  <div class="row"><label for="f-tags">${S.labelTags}</label>
    <input type="text" id="f-tags" value="${esc(prefill.tags)}"></div>
  <div class="row"><label for="f-jump">${S.labelJump}</label>
    <input type="text" id="f-jump" value="${esc(prefill.jump)}" placeholder="bastion"></div>
  <div class="row"><label for="f-pauth">${S.labelPasswordAuth}</label>
    <select id="f-pauth">
      <option value="inherit"${sel("inherit", prefill.passwordAuth)}>${S.paInherit}</option>
      <option value="on"${sel("on", prefill.passwordAuth)}>${S.paOn}</option>
      <option value="off"${sel("off", prefill.passwordAuth)}>${S.paOff}</option>
    </select></div>
  <div class="row"><label for="f-s5u">${S.labelSocks5User}</label>
    <input type="text" id="f-s5u" value="${esc(prefill.socks5User)}"></div>
  <div class="row"><label for="f-s5p">${S.labelSocks5Password}</label>
    <input type="password" id="f-s5p" value="" autocomplete="off">
    <p class="hint" id="s5hint"${socksSet ? "" : ' style="display:none"'}>${S.socksSetHint}</p></div>
  <div class="row inline" id="s5clear-row"${socksSet ? "" : ' style="display:none"'}>
    <input type="checkbox" id="f-s5clear"><label for="f-s5clear">${S.socksClear}</label></div>
  <div id="err"></div>
  <div class="actions">
    <button type="submit" id="save">${S.actionSave}</button>
    <button type="button" id="cancel">${S.actionCancel}</button>
  </div>
</form>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
function applyFields(f, socksSet) {
  document.getElementById("f-name").value = f.name;
  document.getElementById("f-type").value = f.type;
  document.getElementById("f-local").value = f.local;
  document.getElementById("f-remote").value = f.remote;
  document.getElementById("f-ssh").value = f.ssh;
  document.getElementById("f-identity").value = f.identity;
  document.getElementById("f-enabled").checked = !!f.enabled;
  document.getElementById("f-tags").value = f.tags;
  document.getElementById("f-jump").value = f.jump;
  document.getElementById("f-pauth").value = f.passwordAuth;
  document.getElementById("f-s5u").value = f.socks5User;
  document.getElementById("f-s5p").value = "";
  document.getElementById("f-s5clear").checked = false;
  document.getElementById("s5clear-row").style.display = socksSet ? "" : "none";
  document.getElementById("s5hint").style.display = socksSet ? "" : "none";
  document.getElementById("err").textContent = "";
}
document.getElementById("form").addEventListener("submit", (e) => {
  e.preventDefault();
  // One submit in flight; the extension-side busy guard is the authority,
  // this only keeps the UI honest (a double click must not send two PUTs
  // -- a rename's second one would 404 on the old name).
  document.getElementById("save").disabled = true;
  const val = (id) => document.getElementById(id).value;
  vscode.postMessage({ type: "submit", fields: {
    name: val("f-name"), type: val("f-type"), local: val("f-local"),
    remote: val("f-remote"), ssh: val("f-ssh"), identity: val("f-identity"),
    enabled: document.getElementById("f-enabled").checked,
    tags: val("f-tags"), jump: val("f-jump"), passwordAuth: val("f-pauth"),
    socks5User: val("f-s5u"), socks5Password: val("f-s5p"),
    clearSocks5Password: document.getElementById("f-s5clear").checked,
  }});
});
document.getElementById("cancel").addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
window.addEventListener("message", (ev) => {
  const m = ev.data;
  if (m.type === "error") {
    document.getElementById("err").textContent = m.message;
    document.getElementById("save").disabled = false;
  } else if (m.type === "reload") {
    applyFields(m.fields, m.socksSet);
    document.getElementById("save").disabled = false;
  } else if (m.type === "idle") {
    document.getElementById("save").disabled = false;
  }
});
</script>
</body>
</html>`;
}

function cryptoRandom(): string {
  return randomBytes(16).toString("hex");
}
