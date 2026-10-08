# scalpbot-engine (Blocks 1–2)

Always-on worker that streams OANDA prices for XAU_USD and EUR_USD, builds M1/M5/M15 candles,
reconciles them against OANDA REST, computes indicators and market regime, and sends candles and
heartbeats to your ScalpBot app. It never places trades.

## Setup
1. Copy `.env.example` to `.env` (or set these in your host's dashboard):
   - `OANDA_TOKEN`, `OANDA_ACCOUNT_ID` from your OANDA practice account (Manage API Access)
   - `OANDA_ENV=practice`
   - `LOVABLE_FN_URL` = your app address + `/api/public/worker`
   - `WORKER_SECRET` = the same long password saved in the ScalpBot app
2. `npm install && npm test && npm run build && npm start`

## Hosting
Railway / Render / Fly: Node 20, build `npm install && npm run build`, start `npm start`.
Run as a background worker (no web port needed). Keep exactly one instance running.

## Behaviour
- Ticks -> candles aligned to UTC, finalized on first tick of the next bucket.
- 2s after each close, the last 3 REST candles are fetched; REST overwrites if OHLC differs by > 0.30 (XAU) / 0.00020 (EUR).
- No tick for 5s: scanning pauses, a `data_gap` alert is sent, the stream reconnects with exponential backoff and backfills 500 bars.
- Heartbeat every 30s; settings refreshed every 60s. Scanning only inside the IST window (luxon zones).
- Profiles change signal frequency and speed only; risk is always capped by the app.

## Signals (Block 2)
Every closed M5 bar inside the IST window, per pair:
1. Hard filters (window, stale data, paused, DEAD/VOLATILE regime, spread & cost ratio, news blackout ±10 min,
   open-trade / per-window caps, same pair+side in 15 min, cooldown after a loss, SL 0.8–2.0×ATR, RR, key level in the path).
   Failures are logged and sent to the app's skipped-signals list with the reason and all features.
2. Strategies: `pullback` (trend), `sweep` (liquidity sweep reversal), `orb` (opening-range breakout + retest).
3. SL/TP (`sltp.ts`), score 0–100 with breakdown (`scoring.ts`). Emits only when score ≥ the profile minimum.
4. POST ingest-signal with features and an idempotency key (strategy:pair:bar_close), retried 3× with backoff.

## Trade manager
Every 5s reads open trades and alerts (never trades): TP1 hit → close 50% / SL to entry+spread, ATR trail after TP1,
within 0.2R of SL, time stop (45 min and < 0.5R), high-impact news within 10 min. MAE/MFE are sent with each alert.

## News
High-impact USD/EUR events from the Forex Factory weekly calendar (refreshed hourly).
Fallback/extra blackouts: `NEWS_BLACKOUT="2026-10-08T12:30:00Z|US CPI,2026-10-09T12:30:00Z"`.

## Backtest
```
npm run build
node dist/backtest.js --from 2026-06-01 --to 2026-09-30 --pair XAU_USD --pair EUR_USD --profile aggressive --commission 7
```
Same strategy code as live, closed bars only. Costs: average recorded spread per hour, 0.1×spread slippage, commission.
SL is assumed first when SL and TP are inside one bar. The last 30% of the period is reported separately (out-of-sample).
Output in `backtest-out/`: `report.json` (per strategy/pair/hour stats + live gate) and equity CSVs.
Add `--apply` to switch strategies on/off in the app based on the LIVE GATE
(≥100 OOS trades, expectancy ≥ +0.15R, PF ≥ 1.3, max DD ≤ 10R).
Historical news is not available from the free calendar, so backtests only honour `NEWS_BLACKOUT`.

Live: the engine checks weekly and auto-disables a strategy whose live expectancy is below 0 after 50 trades.

## Dry run
`npm run start:dry` — prints signals and trade alerts instead of sending them (candles, heartbeats and other events still go to the app).

## v3 audit changes
- EURUSD max spread from the app (pips, e.g. 1.2) is converted to price (0.00012). Before, the EUR spread filter never blocked.
- Score threshold = max(profile min, app min_score).
- Previous-day high/low skips weekends/holidays.
- Signals that can't reach the app are queued and retried until they expire (never sent late); refused (4xx) signals are dropped.
- Feed watchdog: no ticks 5s (market open) → scanning paused + one data_gap alert; silent connection 10s → reconnect with backoff + backfill. No alerts/reconnect storms on weekends.
- `--dry-run` suppresses only ingest-signal and trade alerts (printed to the console instead); candles, heartbeats and other events still go to the app. Every outbound request logs its method, path and HTTP status.
- Trade-alert state is saved to `STATE_FILE` (default `./scalpbot-state.json`) so restarts don't repeat alerts. Use a persistent volume.
- Tokens are redacted from logs. A fatal error waits 30s before exiting (crash-loop protection).
- Optional `PORT` env: `GET /health` → 200 when ticks are fresh (or market closed), 503 when stale. Point your host's health check at it.
