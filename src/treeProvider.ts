import * as vscode from "vscode";

// Placeholder provider until part 1 wires DaemonClient + SSE in. Shows the
// daemon-absent state so the view is never empty during development.
export class TunnelsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    return [
      {
        label: "Daemon not running",
        description: "part 1 wires the client",
        iconPath: new vscode.ThemeIcon("debug-disconnect"),
        contextValue: "placeholder",
      },
    ];
  }
}
