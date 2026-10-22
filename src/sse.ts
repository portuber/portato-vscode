// SSE consumer for GET /events over the unix socket.
//
// Protocol facts (internal/daemon/server.go, handleEvents):
//   - every frame is a signal-only `data: {}` — no payload; the reaction is
//     to re-fetch GET /tubers
//   - the first frame arrives immediately on connect, so it also drives the
//     initial load — no separate initial fetch is needed
//   - a `: heartbeat` comment every 15 s keeps the stream alive; treat
//     >45 s of silence as a dead stream
//   - log changes do NOT produce events
//
// EventSource cannot be used (it speaks WS-grade URL semantics, not unix
// sockets), so part 1 implements a line-based parser over the response
// stream with reconnect + backoff, re-running discovery and re-reading the
// token on every reconnect.
export interface SseEvents {
  onSignal(): void;
}

export class SseStream {
  constructor(private readonly events: SseEvents) {}

  start(): void {
    throw new Error("not implemented (part 1 MVP)");
  }

  stop(): void {
    throw new Error("not implemented (part 1 MVP)");
  }
}
