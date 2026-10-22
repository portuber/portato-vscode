import * as fs from "node:fs";
import * as http from "node:http";
import type { Healthz, LogEntry, TuberStatus } from "./types";
import { tokenPath } from "./discovery";

// HTTP client over the daemon's unix socket. The transport mirrors
// internal/client/client.go: every request dials the socket, attaches the
// bearer token read from tokenPath(socketPath), and a 401 triggers exactly
// one token re-read + retry (the token is regenerated on each daemon start).
//
// Part 1 (MVP) fills in the request methods; the shape below is the target
// surface the UI code will consume.
export class DaemonClient {
  constructor(private readonly socketPath: string) {}

  socket(): string {
    return this.socketPath;
  }

  private readToken(): string {
    try {
      return fs.readFileSync(tokenPath(this.socketPath), "utf8").trim();
    } catch {
      return "";
    }
  }

  private agent(): http.Agent {
    // Part 1: a custom http.Agent whose createConnection dials the unix
    // socket (node:net), so fetch/http.request speaks HTTP over it.
    throw new Error("not implemented (part 1 MVP)");
  }

  async healthz(): Promise<Healthz> {
    throw new Error("not implemented (part 1 MVP)");
  }

  async tubers(): Promise<TuberStatus[]> {
    throw new Error("not implemented (part 1 MVP)");
  }

  async enable(_name: string): Promise<void> {
    throw new Error("not implemented (part 1 MVP)");
  }

  async disable(_name: string): Promise<void> {
    throw new Error("not implemented (part 1 MVP)");
  }

  async restart(_name: string): Promise<void> {
    throw new Error("not implemented (part 1 MVP)");
  }

  async acceptHost(_name: string): Promise<void> {
    throw new Error("not implemented (part 1 MVP)");
  }

  async setPassphrase(_name: string, _value: string): Promise<void> {
    throw new Error("not implemented (part 1 MVP)");
  }

  async setPassword(_name: string, _value: string): Promise<void> {
    throw new Error("not implemented (part 1 MVP)");
  }

  async logs(_name?: string): Promise<LogEntry[]> {
    throw new Error("not implemented (part 1 MVP)");
  }
}
