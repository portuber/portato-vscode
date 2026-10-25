import { identityT, type Translate } from "./i18n";
import type { TuberState } from "./types";

// Shared per-state UI facts, used by both the tree rows (treeProvider.ts)
// and the quick-pick rows (quickPick.ts): the localized label and the
// theme-icon name. Runtime strings must be extraction-ready LITERALS inside
// t(...) -- the bundle extractor only sees literals -- so the switch lives
// here exactly once instead of being duplicated (or computed dynamically,
// which the extractor cannot see at all). The icon is a plain string: the
// tree wraps it in a ThemeIcon, the quick pick prefixes it as a codicon.

export const STATE_ICONS: Record<TuberState, string> = {
  off: "circle-slash",
  connecting: "sync~spin",
  connected: "circle-filled",
  // Static icon on purpose: reconnecting can last for hours (daemon backoff
  // against a dead host), and a spinning ThemeIcon forces a constant renderer
  // repaint for as long as the view is visible. "connecting" is short-lived,
  // so it keeps the spinner.
  reconnecting: "sync",
  error: "error",
};

export function stateLabel(state: TuberState, t: Translate = identityT): string {
  switch (state) {
    case "off":
      return t("off");
    case "connecting":
      return t("connecting");
    case "connected":
      return t("connected");
    case "reconnecting":
      return t("reconnecting");
    case "error":
      return t("error");
  }
}
