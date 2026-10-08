import { log, logError } from "./logger.js";

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

interface Item { body: Record<string, unknown>; key: string; expiresAt: number; attempts: number; nextAt: number }

/**
 * Signals that could not reach the app are queued and retried with backoff until they expire
 * (a stale signal must never be delivered late). The idempotency key makes retries safe.
 * 4xx (except 429) means the app refused the signal: dropped, never retried.
 */
export class SignalOutbox {
  private items: Item[] = [];
  constructor(private send: (b: Record<string, unknown>) => Promise<unknown>, private now: () => number = Date.now) {}

  get size() { return this.items.length; }

  async submit(body: Record<string, unknown> & { idempotency_key: string }, expiresAt: number): Promise<"sent" | "queued" | "dropped"> {
    if (this.items.some((i) => i.key === body.idempotency_key)) return "queued";
    const item: Item = { body, key: body.idempotency_key, expiresAt, attempts: 0, nextAt: this.now() };
    return this.attempt(item, true);
  }

  async drain() {
    const due = this.items.filter((i) => i.nextAt <= this.now());
    for (const it of due) await this.attempt(it, false);
  }

  private async attempt(it: Item, fresh: boolean): Promise<"sent" | "queued" | "dropped"> {
    const remove = () => { this.items = this.items.filter((x) => x !== it); };
    if (this.now() >= it.expiresAt) { remove(); log("signal_expired_unsent", { key: it.key, attempts: it.attempts }); return "dropped"; }
    it.attempts++;
    try {
      await this.send(it.body);
      remove();
      if (!fresh) log("signal_delivered_from_queue", { key: it.key, attempts: it.attempts });
      return "sent";
    } catch (e) {
      if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 429) {
        remove(); logError("signal_refused", e, { key: it.key }); return "dropped";
      }
      it.nextAt = this.now() + Math.min(60_000, 2_000 * 2 ** (it.attempts - 1));
      if (fresh) this.items.push(it);
      logError("signal_queued", e, { key: it.key, attempts: it.attempts });
      return "queued";
    }
  }
}
