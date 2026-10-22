import * as vscode from "vscode";
import { TunnelsTreeProvider } from "./treeProvider";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new TunnelsTreeProvider();
  vscode.window.registerTreeDataProvider("portatoTunnels", provider);

  const disposables = [
    vscode.commands.registerCommand("portato.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("portato.startDaemon", () => {
      vscode.window.showInformationMessage(
        "portato: daemon start lands in part 1 (MVP)",
      );
    }),
    vscode.commands.registerCommand("portato.enable", () => void 0),
    vscode.commands.registerCommand("portato.disable", () => void 0),
    vscode.commands.registerCommand("portato.restart", () => void 0),
  ];

  context.subscriptions.push(...disposables);
}

export function deactivate(): void {}
