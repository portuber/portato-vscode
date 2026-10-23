import * as fsp from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

// A throwaway HTTP server on a unix socket, standing in for the Portato
// daemon. The handler gets full control of the response so tests can emit
// SSE streams, delayed answers, 401 rotations and error bodies.

export interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export type FakeHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
) => void | Promise<void>;

export interface FakeDaemon {
  socketPath: string;
  tokenPath: string;
  requests: CapturedRequest[];
  setToken(token: string): Promise<void>;
  close(): Promise<void>;
}

export async function makeTempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "portato-vscode-test-"));
}

export async function startFakeDaemon(opts: {
  dir: string;
  token?: string;
  handler: FakeHandler;
}): Promise<FakeDaemon> {
  const socketPath = path.join(opts.dir, "daemon.sock");
  const tokenFile = path.join(opts.dir, "portato.token");
  const requests: CapturedRequest[] = [];

  if (opts.token !== undefined) {
    await fsp.writeFile(tokenFile, opts.token, { mode: 0o600 });
  } else {
    // Tests share a temp dir; never let a previous test's token leak in.
    await fsp.rm(tokenFile, { force: true });
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      void opts.handler(req, res, Buffer.concat(chunks).toString("utf8"));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  return {
    socketPath,
    tokenPath: tokenFile,
    requests,
    async setToken(token: string) {
      await fsp.writeFile(tokenFile, token, { mode: 0o600 });
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
      await fsp.rm(socketPath, { force: true });
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
