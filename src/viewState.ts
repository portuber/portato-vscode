// Context-key derivation for the tree's viewsWelcome contents. The tree
// renders zero rows in every state below except "ok-ish", and package.json
// gates the welcome text on the portato:viewState context key.
//
// "loading" is the initial value and the never-flash guarantee: discovery
// is async, and showing "daemon not running" (with its Start button) for a
// few hundred milliseconds on every window load would teach users to ignore
// it. noBinary likewise only wins once the async binary check has actually
// answered false -- until then "stopped" stays honest.

export type ViewState =
  | "loading"
  | "noBinary"
  | "stopped"
  | "rejected"
  | "empty"
  | "ok";

export interface ViewStateFacts {
  /** undefined = the async binary check has not answered yet. */
  readonly binaryAvailable: boolean | undefined;
  /** undefined = before the first connect attempt -- never guess. */
  readonly daemonUp: boolean | undefined;
  /** The daemon answered 401: provably alive, rejecting the IPC token. */
  readonly authRejected: boolean;
  /** undefined = statuses not fetched for THIS daemon yet. */
  readonly tuberCount: number | undefined;
}

export function deriveViewState(f: ViewStateFacts): ViewState {
  if (f.daemonUp === undefined) return "loading";
  if (f.authRejected) return "rejected";
  if (!f.daemonUp) return f.binaryAvailable === false ? "noBinary" : "stopped";
  if (f.tuberCount === undefined) return "loading";
  return f.tuberCount === 0 ? "empty" : "ok";
}
