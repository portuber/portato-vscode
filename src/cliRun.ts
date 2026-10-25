import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Thin async wrapper for one-shot portato CLI invocations (import preview,
// anything else that must match the binary the user configured). No shell is
// involved: execFile passes argv verbatim, so host patterns from ~/.ssh/config
// can never be re-interpreted by a shell. The binary path itself is resolved
// by the caller (extension.ts passes daemonLifecycle's binaryPath()) so this
// module stays vscode-free and unit-testable against `node`.

const execFileAsync = promisify(execFile);

export interface CliCapture {
  code: number;
  stdout: string;
  stderr: string;
  /** True when the process was killed by the timeout, not exited by itself. */
  timedOut: boolean;
}

/**
 * Run a CLI to completion, capturing output. A non-zero exit is a RESULT,
 * never a throw -- callers decide whether a code is an error. Only a failure
 * to spawn at all (ENOENT) also comes back as code 1 with the error in
 * stderr, so the UI can show one consistent message shape.
 */
export async function runCliCapture(
  binary: string,
  args: string[],
  timeoutMs = 20_000,
): Promise<CliCapture> {
  try {
    const { stdout, stderr } = await execFileAsync(binary, args, {
      timeout: timeoutMs,
      encoding: "utf8",
    });
    return { code: 0, stdout: stdout ?? "", stderr: stderr ?? "", timedOut: false };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      killed?: boolean;
    };
    const text = (v: string | Buffer | undefined): string =>
      typeof v === "string" ? v : v?.toString("utf8") ?? "";
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: text(err.stdout),
      stderr: text(err.stderr) || (err.message ?? "failed to run"),
      timedOut: err.killed === true,
    };
  }
}
