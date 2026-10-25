// Minimal vscode API stub for the controller glue test.
//
// The extension bundle keeps `vscode` external (it is provided by the
// extension host). The test build aliases `vscode` to THIS file
// (esbuild.js, testConfig), so only the glue test ever loads it; pure
// module tests never import vscode at all. tsc still typechecks against
// @types/vscode because the alias lives in esbuild, not in tsconfig.
//
// Keep this file dependency-free and synchronous where possible: the stub
// surface mirrors only what PortatoController touches at construction and
// during connect/dispose. Anything else throws, so missing surface fails
// loudly instead of silently passing.
//
// createOutputChannel honors `{ log: true }`: such channels carry the
// LogOutputChannel level methods (recorded into logLines, never printed).
// Calling a level method on a plain channel throws, and the string overload
// ("log" languageId, used by the daemon log channel) yields a plain channel.

// -- shared observable state ------------------------------------------------

export type RecordedCommand = { cmd: string; args: unknown[] };

export const stubState = {
  /** every executeCommand call, in order */
  commands: [] as RecordedCommand[],
  /** every show*Message call */
  messages: [] as { kind: string; msg: string }[],
  /** settings bag returned by getConfiguration("portato") */
  config: {} as Record<string, unknown>,
  /** status bar items created so far (alive ones) */
  statusBarItems: [] as StatusBarItemStub[],
  /** output channels created so far */
  channels: [] as OutputChannelStub[],
  /** terminals created so far */
  terminals: [] as TerminalStub[],
};

export function resetStub(): void {
  stubState.commands = [];
  stubState.messages = [];
  stubState.config = {};
  stubState.statusBarItems = [];
  stubState.channels = [];
  stubState.terminals = [];
}

/** last value sent via setContext(key); keys use a colon, e.g. "portato:viewState" or "portato:daemonRunning" */
export function lastContext(key: string): unknown {
  for (let i = stubState.commands.length - 1; i >= 0; i--) {
    const c = stubState.commands[i];
    if (c !== undefined && c.cmd === "setContext" && c.args[0] === key) {
      return c.args[1];
    }
  }
  return undefined;
}

// -- EventEmitter (treeProvider constructs one) ------------------------------

export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  readonly event = (l: (e: T) => void): { dispose(): void } => {
    this.listeners.push(l);
    return { dispose: () => this.off(l) };
  };
  fire(e: T): void {
    for (const l of [...this.listeners]) l(e);
  }
  private off(l: (e: T) => void): void {
    this.listeners = this.listeners.filter((x) => x !== l);
  }
  dispose(): void {
    this.listeners = [];
  }
}

// -- window surface ----------------------------------------------------------

export interface StatusBarItemStub {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  backgroundColor: unknown;
  alignment: number;
  priority: number;
  visible: boolean;
  disposed: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface OutputChannelStub {
  name: string;
  appended: string[];
  /** lines emitted through the LogOutputChannel level methods ({ log: true }) */
  logLines: { level: string; msg: string }[];
  shown: boolean;
  disposed: boolean;
  append(value: string): void;
  appendLine(value: string): void;
  replace(value: string): void;
  clear(): void;
  show(): void;
  hide(): void;
  dispose(): void;
  // LogOutputChannel surface; implemented only for { log: true } channels.
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  trace(msg: string, ...args: unknown[]): void;
}

export interface TerminalStub {
  name: string;
  disposed: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
}

function record(kind: string, msg: string): void {
  stubState.messages.push({ kind, msg });
}


export const window = {
  createStatusBarItem(
    alignment?: number,
    priority?: number,
  ): StatusBarItemStub {
    const item: StatusBarItemStub = {
      text: "",
      tooltip: undefined,
      command: undefined,
      backgroundColor: undefined,
      alignment: alignment ?? 1,
      priority: priority ?? 0,
      visible: false,
      disposed: false,
      show() {
        this.visible = true;
      },
      hide() {
        this.visible = false;
      },
      dispose() {
        this.disposed = true;
      },
    };
    stubState.statusBarItems.push(item);
    return item;
  },
  createOutputChannel(
    name: string,
    options?: { log?: boolean } | string,
  ): OutputChannelStub {
    const isLogChannel =
      typeof options === "object" &&
      options !== null &&
      options.log === true;
    const level =
      (lvl: string) =>
      (msg: string): void => {
        if (!isLogChannel) {
          throw new Error(`stub: ${lvl}() on a non-log channel`);
        }
        ch.logLines.push({ level: lvl, msg });
      };
    const ch: OutputChannelStub = {
      name,
      appended: [],
      logLines: [],
      shown: false,
      disposed: false,
      append(value) {
        this.appended.push(value);
      },
      appendLine(value) {
        this.appended.push(value + "\n");
      },
      replace(value) {
        this.appended = [value];
      },
      clear() {
        this.appended = [];
      },
      show() {
        this.shown = true;
      },
      hide() {
        this.shown = false;
      },
      dispose() {
        this.disposed = true;
      },
      info: level("info"),
      warn: level("warn"),
      error: level("error"),
      debug: level("debug"),
      trace: level("trace"),
    };
    stubState.channels.push(ch);
    return ch;
  },
  createTerminal(options: { name?: string }): TerminalStub {
    const term: TerminalStub = {
      name: options?.name ?? "terminal",
      disposed: false,
      show() {},
      hide() {},
      dispose() {
        this.disposed = true;
      },
    };
    stubState.terminals.push(term);
    return term;
  },
  showInformationMessage(msg: string): Promise<undefined> {
    record("info", msg);
    return Promise.resolve(undefined);
  },
  showWarningMessage(msg: string): Promise<undefined> {
    record("warn", msg);
    return Promise.resolve(undefined);
  },
  showErrorMessage(msg: string): Promise<undefined> {
    record("error", msg);
    return Promise.resolve(undefined);
  },
  // The glue test never answers prompts; resolve-undefined = dismissed.
  showInputBox(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  },
};

// -- commands ----------------------------------------------------------------

export const commands = {
  registerCommand(): { dispose(): void } {
    return { dispose() {} };
  },
  executeCommand(cmd: string, ...args: unknown[]): Promise<unknown> {
    stubState.commands.push({ cmd, args });
    return Promise.resolve(undefined);
  },
};

// -- workspace ---------------------------------------------------------------

export const workspace = {
  getConfiguration(section: string) {
    if (section !== "portato") throw new Error(`stub: section ${section}`);
    return {
      get: (key: string, def?: unknown) =>
        key in stubState.config ? stubState.config[key] : def,
      update(): Promise<void> {
        return Promise.resolve();
      },
    };
  },
  fs: {
    readFile(): Promise<Uint8Array> {
      return Promise.reject(new Error("stub: workspace.fs.readFile"));
    },
    stat(): Promise<{ type: number }> {
      return Promise.reject(new Error("stub: workspace.fs.stat"));
    },
  },
  workspaceFolders: undefined,
  onDidChangeConfiguration(): { dispose(): void } {
    return { dispose() {} };
  },
};

// -- l10n --------------------------------------------------------------------

export const l10n = {
  // Identity with {0}/{1}/... substitution: enough for assertions and
  // identical to the runtime behavior for untranslated bundles.
  t(format: string, ...args: (string | number)[]): string {
    return format.replace(/\{(\d+)\}/g, (m, i) => {
      const v = args[Number(i)];
      return v === undefined ? m : String(v);
    });
  },
};

// -- module-level classes ----------------------------------------------------

export class TreeItem {
  label?: string | { label: string };
  description?: string;
  tooltip?: string;
  contextValue?: string;
  iconPath?: unknown;
  collapsibleState: number;
  command?: unknown;
  constructor(label?: string, collapsibleState?: number) {
    this.label = label;
    this.collapsibleState = collapsibleState ?? 0;
  }
}

export class ThemeIcon {
  constructor(readonly id: string, readonly color?: ThemeColor) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class Disposable {
  constructor(readonly call: () => void) {}
  dispose(): void {
    this.call();
  }
  static from(...items: { dispose(): void }[]): Disposable {
    return new Disposable(() => {
      for (const d of items) d.dispose();
    });
  }
}

// -- enums / constants (values match @types/vscode) --------------------------

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
} as const;
export const QuickPickItemKind = { Separator: -1, Default: 0 } as const;
export const ViewColumn = { Active: 1, Beside: 2, One: 1 } as const;
export const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
} as const;

export class Position {
  constructor(readonly line: number, readonly character: number) {}
}
export class Range {
  constructor(
    readonly start: Position | { line: number; character: number },
    readonly end: Position | { line: number; character: number },
  ) {}
}

export class Uri {
  constructor(readonly scheme: string, readonly fsPath: string) {}
  static file(p: string): Uri {
    return new Uri("file", p);
  }
  with(): Uri {
    return this;
  }
  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }
}

// The tree provider's drag-and-drop controller (treeProvider.ts) uses
// DataTransfer/DataTransferItem; the glue test never drags, but the tree
// module's imports must resolve.
export class DataTransfer {
  private map = new Map<string, DataTransferItem>();
  set(mime: string, item: DataTransferItem): void {
    this.map.set(mime, item);
  }
  get(mime: string): DataTransferItem | undefined {
    return this.map.get(mime);
  }
  forEach(fn: (item: DataTransferItem, mime: string) => void): void {
    for (const [mime, item] of this.map) fn(item, mime);
  }
}
export class DataTransferItem {
  constructor(readonly value: unknown) {}
  asString(): Promise<string> {
    return Promise.resolve(String(this.value));
  }
}

export const env = {
  openExternal(): Promise<boolean> {
    return Promise.resolve(true);
  },
  appName: "vscode-stub",
  language: "en",
};

export const extensions = {
  getExtension(): undefined {
    return undefined;
  },
};
