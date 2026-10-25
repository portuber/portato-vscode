// Pure logic behind the add/edit tunnel webview form. Kept free of vscode
// so it is unit-testable. Contract facts driving the shapes:
//   - PUT /tubers/{name} replaces the tuber wholesale, so the submit body
//     merges the form over the FRESH raw config snapshot: unknown future
//     daemon fields survive the spread instead of being dropped.
//   - password_auth is *bool: absent = inherit (defaults), true = on,
//     false = opt out. The form exposes three states and "inherit" removes
//     the key.
//   - Secrets never reach the webview: socks5_password is a set/unset flag
//     plus an always-empty input; the submit decides set/clear/keep from
//     the flag and whether the user typed a value.

import { identityT, type Translate } from "./i18n";

export type TuberTypeChoice = "local" | "remote" | "dynamic";
export type PasswordAuthChoice = "inherit" | "on" | "off";

/** Field values exactly as the webview posts them. */
export interface TuberFormFields {
  name: string;
  type: TuberTypeChoice;
  local: string;
  remote: string;
  ssh: string;
  identity: string;
  enabled: boolean;
  /** Comma-separated raw text; normalizeTags parses it. */
  tags: string;
  jump: string;
  passwordAuth: PasswordAuthChoice;
  socks5User: string;
  /** Always empty on load; a typed value means "set this". */
  socks5Password: string;
  /** Offered only when the tuber already has a password: remove it. */
  clearSocks5Password: boolean;
}

export function emptyForm(): TuberFormFields {
  return {
    name: "",
    type: "local",
    local: "",
    remote: "",
    ssh: "",
    identity: "",
    enabled: true,
    tags: "",
    jump: "",
    passwordAuth: "inherit",
    socks5User: "",
    socks5Password: "",
    clearSocks5Password: false,
  };
}

/** Parse the tags text field: split, trim, drop empties, dedupe, keep order. */
export function normalizeTags(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(",")) {
    const t = part.trim();
    if (t !== "" && !out.includes(t)) out.push(t);
  }
  return out;
}

export function tagsToText(tags: unknown): string {
  return Array.isArray(tags) ? tags.filter((t) => typeof t === "string").join(", ") : "";
}

/** Fill the form from a raw config tuber (undefined = Add). */
export function prefillFrom(raw: Record<string, unknown> | undefined): TuberFormFields {
  if (!raw) return emptyForm();
  const str = (k: string): string => (typeof raw[k] === "string" ? (raw[k] as string) : "");
  const type = raw.type;
  const pa = raw.password_auth;
  return {
    ...emptyForm(),
    name: str("name"),
    type:
      type === "remote" || type === "dynamic" ? type : "local",
    local: str("local"),
    remote: str("remote"),
    ssh: str("ssh"),
    identity: str("identity"),
    enabled: raw.enabled !== false,
    tags: tagsToText(raw.tags),
    jump: str("jump"),
    passwordAuth: pa === true ? "on" : pa === false ? "off" : "inherit",
    socks5User: str("socks5_user"),
    socks5Password: "",
    clearSocks5Password: false,
  };
}

/**
 * Client-side validation; returns an error message or null. `t` localizes
 * the messages (identity default keeps the module vscode-free for tests).
 */
export function validateFields(f: TuberFormFields, t: Translate = identityT): string | null {
  if (f.name.trim() === "") return t("Name is required");
  if (f.type !== "local" && f.type !== "remote" && f.type !== "dynamic") {
    return t("Invalid tunnel type");
  }
  return null;
}

/**
 * Merge the form over the raw config snapshot into a PUT/POST body.
 * Scalar text fields are always written (trimmed); optional fields drop
 * their key when empty so the daemon's omitempty shapes are preserved.
 * `original` is undefined for Add.
 */
export function buildTuberBody(
  original: Record<string, unknown> | undefined,
  f: TuberFormFields,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...(original ?? {}) };
  body.name = f.name.trim();
  body.type = f.type;
  body.local = f.local.trim();
  body.remote = f.remote.trim();
  body.ssh = f.ssh.trim();
  body.identity = f.identity.trim();
  body.enabled = f.enabled;
  body.socks5_user = f.socks5User.trim();

  const tags = normalizeTags(f.tags);
  if (tags.length > 0) body.tags = tags;
  else delete body.tags;

  const jump = f.jump.trim();
  if (jump !== "") body.jump = jump;
  else delete body.jump;

  if (f.passwordAuth === "inherit") delete body.password_auth;
  else body.password_auth = f.passwordAuth === "on";

  if (f.socks5Password !== "") body.socks5_password = f.socks5Password;
  else if (f.clearSocks5Password) body.socks5_password = "";
  // Otherwise keep the original untouched: the secret never reached the
  // form, so "empty input" means "leave as is".
  return body;
}

/**
 * Order-insensitive deep comparison of two raw tuber objects as canonical
 * JSON. Used both for the conflict check (fresh config vs the open-form
 * snapshot) and to skip a PUT that would not change anything.
 */
export function tuberChanged(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return canonicalTuber(a) !== canonicalTuber(b);
}

export function canonicalTuber(t: Record<string, unknown>): string {
  const keys = Object.keys(t)
    .filter((k) => t[k] !== undefined)
    .sort();
  return JSON.stringify(keys.map((k) => [k, t[k]]));
}

/**
 * Daemon bug D2 mitigation decision (consult D-8): a wholesale PUT that
 * flips `enabled` does not apply on some daemon versions until restart,
 * so the form must follow it with an explicit enable/disable IPC call.
 * Pure decision only -- "none" means no flip, no follow-up.
 */
export function enableFollowUp(
  body: Record<string, unknown>,
  fresh: Record<string, unknown>,
): "none" | "enable" | "disable" {
  if (typeof body.enabled !== "boolean") return "none";
  const was = fresh.enabled === true;
  if (body.enabled === was) return "none";
  return body.enabled ? "enable" : "disable";
}
