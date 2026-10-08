/**
 * Feed health. `stale` (no price tick for STALE_MS while the market is open) pauses scanning and
 * raises one data_gap alert. `reconnect` fires when the connection itself is silent (no tick and
 * no stream heartbeat) for DEAD_MS. When the FX market is closed nothing is flagged, so weekends
 * do not cause reconnect storms or alert spam.
 */
export class FeedGuard {
  lastTick: number;
  lastMsg: number;
  stale = false;
  constructor(now: number, private staleMs = 5_000, private deadMs = 10_000) { this.lastTick = now; this.lastMsg = now; }

  tick(now: number): "resumed" | null {
    this.lastTick = now; this.lastMsg = now;
    if (this.stale) { this.stale = false; return "resumed"; }
    return null;
  }
  heartbeat(now: number) { this.lastMsg = now; }

  check(now: number, marketOpen: boolean): { reconnect: boolean; becameStale: boolean } {
    if (!marketOpen) return { reconnect: now - this.lastMsg > 60_000, becameStale: false };
    const becameStale = !this.stale && now - this.lastTick > this.staleMs;
    if (becameStale) this.stale = true;
    return { reconnect: now - this.lastMsg > this.deadMs || now - this.lastTick > this.deadMs, becameStale };
  }
}
