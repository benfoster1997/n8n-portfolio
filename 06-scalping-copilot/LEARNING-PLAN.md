# Plan: history replay, automatic trade journal, and a learning layer

**Status (14 Oct 2026): approved by the user, NOT yet reviewed, NOTHING built.** The user paused the
work before the three-lens critique of this plan (statistics/leakage, product rules, engineering)
finished; none of the critics returned. On resume: run that critique first (lenses below, under
"Review still to run"), fold its fixes into this file, then build. HANDOFF.md → "Where we stopped"
has the order of work.

Repo: /home/user/n8n-portfolio, project 06-scalping-copilot/, branch claude/xauusd-btcusd-chart-analysis-8pvje5.
Read 06-scalping-copilot/HANDOFF.md (decisions 8, 22–26 especially) before judging anything here.
The user (non-technical, UK, demo account, trades 08:00–16:00 London on MT5 iPhone, M15 chart)
asked (14 Oct 2026): (1) a multi-year replay that records why each alert fired and how it ended,
with a breakdown by condition and 2025–26 held back; (2) an automatic trade log of every live alert,
its reasons, its outcome checked against the price feed, and whether they took it; and (3) "a way
for the tool to learn the algorithm of the charts for BTCUSD and XAUUSD".

They were told plainly: a few weeks of their own trades cannot prove anything (3–6 alerts a week);
a single trade's "why" is mostly luck; patterns only count across many trades and must be checked
on data nothing was tuned on; the tool must not rewrite its own rules after each trade.

## Facts the design rests on
- Watcher today: desk/live.mjs `liveRead()` = gate → `analyse()` (src/signal-engine.js) on the last
  300 closed M15 bars with `htfBars` = up to 1,000 → `toPlan()` → `checkPlan()` (src/shot.js).
  Alerts pass `shouldAlert()` (no repeat bar, cooldown 4 bars same side, not while the previous
  alert is `stillRunning`). Target rule `TARGET_RULE = '1.5R'` when no level stands in the way.
- desk/replay.mjs replays that over Binance BTCUSDT M15 history (cached in
  $SCALP_DESK_HOME/history/BTCUSD-M15.json), follows each alert with `outcome()` (buy fills at ask,
  sell exits trigger on ask, both-touched bar = stop, open at window close = closed there), reports
  mean R with a by-day clustered range (desk/stats.mjs `clusteredByDay`).
- 2026 replay (1 Jan–11 Oct): 6,464 checks, 120 alerts, +0.028R/trade, clustered 95% −0.169..+0.225.
  It takes ~7 minutes (≈65 ms per check, single thread). 4 CPUs, 15 GB RAM in the container.
- Binance (data-api.binance.vision), Coinbase, Kraken are reachable (NODE_USE_ENV_PROXY=1 needed for
  Node fetch). Binance BTCUSDT M15 history starts 2017-08-17. Twelve Data (gold) needs
  TWELVEDATA_API_KEY, which is NOT set; free plan ~800 credits/day, 8/min (unconfirmed), up to 5,000
  bars a call; how far back free intraday XAU/USD goes is unknown.
- The news calendar (src/news-calendar.js) covers 2026 only, so earlier history has no blackouts.
- Container state ($SCALP_DESK_HOME, default ~/.scalp-desk) dies with the container; anything that
  must survive is committed in the repo (desk/config.json is the precedent).
- Binance BTCUSDT M15 history 2017-08-17 → 2026-10-14 was fetched on 14 Oct in about two minutes
  (321 calls, 320,623 bars, 26.7 MB JSON) into $SCALP_DESK_HOME/history/BTCUSD-M15.json — container
  state, so a new container fetches it again. It has 33 gaps; the largest are 134 bars from
  2018-02-08, 40 from 2018-06-26 and 2019-05-15, 32 from 2019-08-15. The dataset and replay should
  skip checks whose 300-bar engine window holds a gap of more than 4 bars, and flag a trade that
  spans one.
- Known engine quirk (HANDOFF "One latent engine quirk"): `volumeBucket` reads `lastOf(relVol)`, the
  last bar WITH a baseline, instead of the newest bar; fix = value at the newest bar (abstain if
  none) + test; re-run the 2026 replay and say plainly if decision 26's figures move.

## Part 1 — shared pieces
- `desk/history.mjs`: `loadHistory(pair, tf, fromMs, toMs, {home, fetchImpl})` → closed bars,
  cached per pair/tf, extended incrementally at either end (today's code refetches everything when
  the cache does not cover the range). BTCUSD: Binance BTCUSDT klines, 1,000 a call. XAUUSD: Twelve
  Data XAU/USD `interval=15min&timezone=UTC&outputsize=5000&start_date&end_date`, paging backwards,
  ≥ 8 s between calls, stop at the first empty page; without a key returns `{needKey:true}`. Reports
  coverage (first/last bar, gaps > 3 days excluding weekends for gold).
- `desk/outcome.mjs`: `outcome()` moved out of replay.mjs unchanged in behaviour (buy at ask etc.),
  plus MFE/MAE in R and bars held. Used by replay, dataset and journal.
- Historical cost: bitcoin's spread is $6 at ~$84k (0.71 bps). Applying $6 in 2017 (BTC ~$4k) makes
  cost ~20× larger relative to price than today, so history uses the spread scaled with price at
  constant bps (6 × price / 84,400), stated in every report. Gold: the confirmed $0.05 + commission,
  scaled the same way. 2026 reports keep the fixed figure so decision 26 still compares.

## Part 2 — multi-year replay with reasons (approved by the user)
- `node desk/replay.mjs --pair bitcoin --from 2017-09-01 [--to] [--rule 1.5R] [--workers 4]
  [--by-condition] [--list]`: same per-check logic as now, split into date chunks across worker
  processes (child_process / worker_threads) with a warm-up of ≥ 1,000 bars before each chunk, and
  `shouldAlert` state carried correctly across chunk boundaries (run chunks for reads in parallel,
  then apply the alert/stillRunning/cooldown sequence serially over the merged reads).
- Each alert row records: time, side, confidence, netR, stop/target distances in R and in ATR,
  regime, every bucket score, H1/H4 bias, hour, weekday, the engine's top reasons, and the outcome
  (how, R, bars, MFE, MAE).
- `--by-condition`: mean R, count and clustered range per condition (regime, confidence label,
  H1/H4 agreement, each bucket's sign, hour band 08–10/10–12/12–14/14–16, weekday, side), each with
  a "too few to say" floor (n < 30), and a warning that with ~30 conditions about 1–2 will look
  "significant" by chance at 95%.
- Held back: rows on or after 2025-01-01 are reported separately and never used to choose anything.

## Part 3 — automatic trade journal (approved)
- `desk/journal.json`, committed: one entry per live alert (watch or scan): id, pair, tf, alert
  time (bar close), side, feed + refPrice, stopDist, tp1Dist, netR, confidence, reasons, against,
  a features snapshot (same feature vector as the learner), the learner's estimate if any, and
  status open → resolved {how, R, MFE, MAE, bars} from FEED bars via `outcome()`, labelled "on the
  feed's prices, not your fills".
- Taken: `take` that returns ok marks the alert `ticketed` with the user's price and ticket levels;
  "took it" (`plan took`) marks the newest alert still within its validity as `taken`. The user can
  report the real result: `journal result --id N --r 1.4` or `--how stop|target|manual` → `actual`.
- Resolution runs automatically at the start of `watch`, `scan`, `now`, `brief` and via
  `journal update` (network: fetch bars since the oldest open entry; never blocks the main reply).
- `journal` (no args) → plain-English summary: alerts so far, taken, resolved outcomes, average R
  with clustered range, by-condition breakdown only above the n ≥ 30 floor, and the committed-sample
  status from desk/config.json `record.plannedSample` (no verdict before it, decision 8).
- Per-trade "what happened" (facts, not stories): reached target / stopped / closed at 16:00; how
  far it went for and against (MFE/MAE in R); bars held; a release during the trade (2026 calendar);
  stopped within the first bar; and "past similar setups" from the dataset (Part 4) when available.
- The session commits and pushes desk/journal.json after it changes (as with config.json).

## Part 4 — the learning layer ("learn the charts")
Honest framing to the user: markets do not run on a fixed algorithm; what can be learned is which
measurable conditions, in the past, came before better or worse results, and whether that still
held on years the learner never saw. Most such patterns fade; the tool will say so if they do.

Dataset (`node desk/dataset.mjs --pair bitcoin [--from 2017-09-01] [--workers 4]`):
- One row per window check (weekday bar closes 08:00–16:00 London; ≈ 76k for bitcoin 2017→2026),
  cached in $SCALP_DESK_HOME/learn/<pair>-<tf>.rows.jsonl (rebuildable; not committed).
- Features (all price-free: ATR units, percentiles, scores): engine net, confidence, each bucket
  score (+ abstain flag for volume), regime one-hot, efficiency ratio, H1/H4 bias scores and agree;
  returns over 1/4/16/96 bars ÷ ATR; ATR÷price and its percentile over the last 1,000 bars; close
  vs EMA21, EMA50, session VWAP ÷ ATR; RSI; Bollinger %b; last bar range ÷ ATR; distance to nearest
  level above/below ÷ ATR; relative volume; hour band one-hot; weekday one-hot.
- Labels: (a) the watcher's own trade on the engine's lean (its stop + 1.5R-when-clear target),
  with kind ∈ {idea, rejected, none, blocked} and whether it would have alerted; (b) a standard long
  AND short from the same bar: stop = max(1.2 × ATR, the engine's noise-scaled minimum stop), target
  1.5R, same fills/costs/window close. Outcomes are R after costs, plus MFE/MAE.

Models (pure JavaScript, no new dependencies, deterministic):
- Ridge regression of R on standardised features (λ from a fixed grid), and a k-nearest-neighbours
  "similar setups" summary (k = 200, standardised features) for explanation. No boosted trees or
  neural nets: few thousand effective samples, heavy overlap, and interpretability matter more.

Validation — written before any result is seen:
- Holdout: 2025-01-01 → latest bar. Untouched until the recipe is frozen; evaluated once, with the
  run recorded in desk/model.json (date, data range, hash). `learn fit` refuses holdout rows unless
  `--final`, and `--final` refuses if model.json already records a final run for that recipe hash.
- Development: expanding-window walk-forward, test years 2019–2024; train on everything before the
  test year with a 2-day purge (labels span up to the window close, and features look back days).
  λ and the threshold τ are chosen on walk-forward results only (grid: λ ∈ {1, 10, 100},
  τ ∈ {0, 0.05, 0.10, 0.15}R), preferring the simpler (larger λ, smaller τ) on near-ties.
- Pre-declared tests on the holdout (two tests, so each at 97.5%):
  P1 "filter": among watcher alerts (engine ideas that pass every check and shouldAlert), alert only
     when the predicted R > τ. Pass = by-day clustered 97.5% lower bound of mean R > 0 AND at least
     50 alerts in the holdout.
  P2 "direction from scratch": at every window check, take the side with the higher predicted R if
     it is > τ, one position at a time per instrument (same stillRunning/cooldown rules). Same pass
     rule.
  Baselines always shown next to them on the same holdout: the unfiltered watcher, and a coin-flip
  side with the same stops (expected ≈ −cost).
- Outcome handling: a model that passes is `active` in desk/model.json; a model that fails is
  `info-only`. Active: the watcher alerts only when the model agrees, and the alert shows its
  estimate. Info-only: alerts are unchanged and show "past similar setups" (kNN: how many, how
  many reached target, average R) with one line saying the learner found nothing that held up.
- Never: the model cannot bypass the gate, the dead zone, blackouts, `checkPlan()` or sizing; it
  can only remove alerts (P1) or, if P2 passed, propose a side that then goes through the same gate
  and checks. It never retrains itself silently: `learn update` (monthly, by the session when asked
  or when `learn status` says the model is over 35 days old) refits on all data up to last month;
  the holdout result stays attached to the recipe, and from then on only the live journal is
  untouched evidence.
- Reports to the user in plain English: what helped, what hurt, how much, whether it held on
  2025–26, and the coin-flip baseline beside it.

Gold: the same pipeline. Without TWELVEDATA_API_KEY every gold step returns need-key with the same
instructions as `scan --pair gold`. No PAXG stand-in for learning.

## Engineering
- New files: desk/history.mjs, desk/outcome.mjs, desk/features.mjs, desk/dataset.mjs,
  desk/learn.mjs (model + CLI), desk/journal.mjs, desk/journal.json, desk/model.json;
  tests test/history.test.mjs, test/journal.test.mjs, test/learn.test.mjs (synthetic data and the
  existing fixture test/fixtures/btc-m15.json; no network; fetch stubbed).
- desk.mjs gains `journal [update|result]`, `learn [status|build|fit|report|update]`; live.mjs
  attaches the features snapshot and model estimate to ideas; SKILL.md, README, HANDOFF updated.
- test/run-all.mjs must stay under a few minutes; long runs are CLI only.

## Review still to run (before any code)
Three critics, independent, read-only, each returning issues with severity, evidence and a concrete
fix to this plan:
1. **Statistics / leakage:** look-ahead in features or labels; purge/embargo versus 1,000-bar
   features and labels that run to 16:00; overlapping labels and effective sample size; honest
   multiple-testing for λ/τ selection plus two holdout tests (97.5% each?); the 50-alert floor;
   ridge on bounded R; whether P2 should exist; 2026 having been used to choose the 1.5R rule;
   constant-bps spread scaling; the coin-flip baseline; multiple comparisons in the by-condition
   breakdown; what effect size the holdout can detect.
2. **Product rules / the user:** every HANDOFF decision and SKILL.md "Never" rule the plan touches;
   decision 8 versus a historical "pass"; how "past similar setups" is worded so it is not read as
   a prediction; an active model changing the meaning of the committed live sample (it must be one
   fixed method); nothing personal in a committed journal.json; feed-price outcomes not mistaken
   for real P&L; framing monthly retraining.
3. **Engineering:** the parallel replay reproducing the single-thread 2026 run exactly (6,464
   checks; reads none 2,600 / rejected 3,291 / idea 359 / blocked 214; 120 alerts; +0.028R);
   runtime (≈65 ms a check, ~76k checks, 4 CPUs) and computing analyse() once for both replay and
   dataset; cache extension; Binance and Twelve Data paging and limits; NODE_USE_ENV_PROXY;
   keeping run-all fast; committing journal.json/model.json from a session; engine states with no
   buckets; which parts separate agents can build in parallel without editing the same files.
