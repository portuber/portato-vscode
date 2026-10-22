import { spawn } from "node:child_process";
import * as vscode from "vscode";

// `portato daemon` runs in the FOREGROUND. Launch it detached so it survives
// the extension host: { detached: true, stdio: "ignore" } + unref().
// Readiness = discovery finds a socket that answers /healthz (NOT the socket
// file appearing — it shows up before the token file is written).
// A second daemon is rejected by flock and exits with "daemon already
// running" — surface that message instead of a generic spawn error.
export function binaryPath(): string {
  return vscode.workspace.getConfiguration("portato").get<string>("binaryPath") || "portato";
}

export function spawnDaemon(): void {
  const child = spawn(binaryPath(), ["daemon"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
