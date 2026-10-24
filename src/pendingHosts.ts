import type { TuberStatus } from "./types";

/**
 * Applies one /tubers snapshot to the remembered pending host keys.
 *
 * The daemon clears `pending_host` at the start of every dial and sets it
 * again only on a TOFU rejection, so during the short `connecting` window of
 * a redial the live field is empty while the prompt is still outstanding.
 * Remembering the host keeps the tree item's "prompting" contextValue (and
 * its inline action) stable through that window. In every other state the
 * map mirrors the live field: a tuber that goes error/reconnecting without
 * `pending_host` (accepted key, dial failed for another reason) is pruned so
 * the answer action does not linger on a prompt that will never come.
 */
export function updatePendingHosts(
  map: Map<string, string>,
  statuses: TuberStatus[],
): void {
  const live = new Set(statuses.map((s) => s.name));
  for (const s of statuses) {
    if (s.pending_host) {
      map.set(s.name, s.pending_host);
    } else if (s.state !== "connecting") {
      map.delete(s.name);
    }
  }
  for (const name of map.keys()) {
    if (!live.has(name)) map.delete(name);
  }
}
