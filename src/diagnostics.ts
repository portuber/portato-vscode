import * as vscode from "vscode";

// The extension's OWN diagnostics channel. Per the consult this is a
// LogOutputChannel (timestamps + levels) for lifecycle decisions, daemon
// version warnings and IPC failures. The daemon's log STREAM deliberately
// stays on its plain OutputChannel (src/logsView.ts): LogOutputChannel
// would stamp wall-clock time over the daemon's own timestamps and its
// native level control would fight the minLogLevel filter.
//
// Lazy on purpose: creating a channel nobody ever writes to would pollute
// the Output view for everyone who never hits a diagnostic.

let channel: vscode.LogOutputChannel | undefined;

function ch(): vscode.LogOutputChannel {
  return (channel ??= vscode.window.createOutputChannel("Portato Diagnostics", {
    log: true,
  }));
}

export function diagWarn(msg: string, ...args: unknown[]): void {
  ch().warn(msg, ...args);
}

export function diagInfo(msg: string, ...args: unknown[]): void {
  ch().info(msg, ...args);
}

/** Disposes the lazily created channel; a later write simply recreates it. */
export function disposeDiagnostics(): void {
  channel?.dispose();
  channel = undefined;
}
