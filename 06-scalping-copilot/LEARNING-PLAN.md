# Plan: history replay, automatic trade journal, and a learning layer

**Status (16 Oct 2026): approved by the user (14 Oct); reviewed by three independent critics
(statistics, product rules, engineering) on 16 Oct; this is the revised plan. Build in progress.**
HANDOFF.md → "Where we stopped" has the state of the work.

The user (non-technical, UK, demo account, trades 08:00–16:00 London on MT5 iPhone, M15 chart)
asked on 14 Oct for: (1) a multi-year replay that records why each alert fired and how it ended,
broken down by condition, with 2025–26 held back; (2) an automatic log of every live alert, its
reasons, its outcome on the price feed, and whether they took it; (3) "a way for the tool to learn
the algorithm of the charts for BTCUSD and XAUUSD". They were told: a few weeks of their own trades
cannot prove anything; one trade's "why" is mostly luck; patterns count only across many trades and
on data nothing was tuned on; the tool must not rewrite its own rules after each trade.

Honest framing for the user: markets do not run on a fixed algorithm. What can be learned is which
measurable conditions came before better or worse results in the past, and whether that still held
on years the learner never saw. Most such patterns fade; the tool says so when they do.

---

## Facts the design rests on (measured)

- Watcher: desk/live.mjs `liveRead()` = gate → `analyse()` on the last 300 closed M15 bars with
  `htfBars` up to 1,000 → `toPlan()` → `checkPlan()`. Alerts pass `shouldAlert()` (no repeat bar;
  4-bar same-side cooldown; not while the previous alert is `stillRunning`). `TARGET_RULE = '1.5R'`.
- 2026 replay (1 Jan–11 Oct; re-run twice on 16 Oct, identical): 6,464 checks; reads none 2,600 /
  rejected 3,291 / idea 359 / blocked 214; 120 alerts; +0.028R a trade; sd 1.06R; clustered 95%
  −0.169..+0.225; target 24 / stop 41 / window 55; buys 55 at −0.038R, sells 65 at +0.084R.
  ≈65 ms a check single-threaded; 4 CPUs, 15 GB.
- Bitcoin history: Binance BTCUSDT M15, 2017-08-17 → 2026-10-14 20:45 UTC, 320,623 bars, 33 gaps
  (largest 134 bars from 2018-02-08). 75,805 window checks 2017-09 → 2026-10-11.
- A plain long/short label (stop 1.2 ATR, 1.5R target, to 16:00) leans toward shorts by ~0.09R in
  both 2025 and 2026; the long-minus-short gap swings ±0.1R year to year with no stable sign.
- Same-day labels are strongly overlapping: correlation 0.64 / 0.51 / 0.34 / 0.17 / 0.06 at lags
  1/2/4/8/16 bars; design effect ≈7.2, so 75,805 rows ≈ 10,500 effective. Day means are nearly
  independent (lag-1 autocorrelation 0.018), so by-day clustering is adequate.
- A bar touching both stop and target happens on ~1% of side-trades; counting it as a stop costs
  about as much as the spread (both-sides average −0.031R against a mean cost of 0.0165R).
- No look-ahead found in the engine: `resample()` drops the forming H1/H4 bar; pivots and levels are
  confirmed-only; relative volume uses earlier slots; VWAP is cumulative; replay passes bars up to k
  with nowMs = close + 20 s. Labels stop at 16:00 the same day (median hold 4–8 bars).
- The repository is **public** (GitHub reports visibility public). desk/config.json already
  commits the demo balance.
- Gold needs `TWELVEDATA_API_KEY` (not set as of 16 Oct). The news calendar's tier-1 table covers
  2026 only; rule-based tier-2 events (claims, ISM, ADP) compute for any year using 2026 holidays.
- Known engine quirk: `volumeBucket` reads `lastOf(relVol)` (last bar with a baseline) instead of
  the newest bar. Fix before anything is frozen.

## Rules that bind every part

1. **One method per committed sample.** Turning on, refitting or replacing a filter, or changing the
   engine, the checks or the target rule, ends the sample in progress. The desk says so and asks
   first. The alert method has a `METHOD_VERSION` and a test that hashes the files that decide
   alerts; changing them without a conscious bump fails the test.
2. **The holdout is looked at once.** Fixed window: 2025-01-01 00:00 UTC → 2026-10-14 20:45 UTC.
   The full recipe is committed to desk/model.json *before* any run reports a held-back row.
   Replay, dataset and learner refuse to print or aggregate held-back rows until model.json records
   the final run. Every final run is recorded whatever its recipe; a second one prints "The
   held-back years have already been used once; this result is not on unseen data" and cannot pass.
   2025 (clean) and 2026 (seen while choosing the 1.5R rule) are always reported separately.
3. **Nothing about the learner on a live alert or a push**, in any mode. No number, no "similar
   setups". The model can only *remove* engine alerts, never propose a side, never bypass the gate,
   the dead zone, blackouts, `checkPlan()` or sizing.
4. **No running results in session.** Journal resolution is silent. Between 08:00 and 16:00 London
   on a weekday, `journal` gives process counts only plus: "Results are shown once your session is
   over; checking them mid-session tends to make the next decision worse." A direct question about
   one named alert is answered in R.
5. **Wording.** An alert's outcome is said one of three ways: "The 10:15 bitcoin sell alert reached
   its target (+1.5 times the risk)", "…hit its stop (−1)", "…was closed at the end of the session
   (+0.3)". Never "won", "lost", "you made", never £, never a feed-price level. Summaries are two
   blocks never added together: "**The alerts**: scored on Binance's prices, not your MT5 trades;
   your own result can differ." and "**Your trades**: what you told me (n of them)."
6. **Privacy (public repo).** desk/journal.json holds only an allowlist of fields, enforced by a test.
   Allowed: id, pair, tf, times, side, feed name, refPrice, distances, netR, confidence, engine
   reasons/against text, features, filter output, status, outcome in R and path (MFE/MAE/bars),
   taken {ticketed, userPrice, stopLoss, takeProfit}, actual {R, how}, account mode, method.
   Never: volume or lots, any money amount, balance, risk %, account number, login, server, email,
   phone, or free text from the user or a screenshot. Before the first entry with account mode
   `live`, ask once whether a live trade record may sit in a public repository (and point out that
   config.json's balance would be public too; a shadow balance avoids that).
7. **Only what the live desk could have sent reaches the user.** User-facing reports cover rows of
   kind `idea` with the gate open (gold outside the dead zone; 2026 rows outside blackouts). Other
   rows (rejected, dead zone, blackouts) are developer-only; if they look better, that goes in
   HANDOFF as a candidate rule change needing its own sample — never a tip.
8. **Multi-year caveat** in every multi-year report: "Before 2025 there is no news calendar, so these
   years include trades around releases that the live desk would have sat out." (2025 dates are
   being added; see Part 1.)

## Part 1 — shared pieces

- `desk/outcome.mjs` (done 16 Oct): `outcome()` moved out of replay.mjs unchanged in behaviour,
  plus MFE/MAE in R and a `bothTouched` flag. New scoring option `bothTouched: 'half'` scores such a
  bar as the average of target and stop; reports state how many there were. The replay's legacy
  "stop" rule stays available so decision 26's figures still reproduce.
- `desk/history.mjs`: `loadHistory(pair, tf, fromMs, toMs, {home, fetchImpl})` → closed bars, cached
  per pair/tf, extended incrementally at either end. BTCUSD: Binance klines, 1,000 a call. XAUUSD:
  Twelve Data `interval=15min&timezone=UTC&outputsize=5000`, paging backwards, ≥ 8 s between calls;
  without a key `{needKey:true}`. Reports coverage and gaps. Checks whose 300-bar engine window
  holds a gap of more than 4 bars are skipped; a trade spanning a gap is flagged.
- Costs: train on **gross** R (spread 0, no commission); predict gross and subtract the decision-time
  cost in R. Historical net figures use the spread scaled with price at constant bps (bitcoin
  6 × price / 84,400; gold the confirmed $0.05 + commission scaled the same way). **The holdout
  test uses, per trade, the more pessimistic of the fixed figure and the scaled one.** Sensitivity
  at 2× and 3× bps for pre-2023 years.
- News calendar: add 2025 tier-1 US dates (NFP, CPI, FOMC statement and press conference, PCE as
  available) and 2025 US holidays, from sources, with the 2025 shutdown's delays as they actually
  happened; earlier years only where reliably sourced (FOMC at least). Table-driven only (decision
  4); never derived by rule.

## Part 2 — multi-year replay with reasons

- One shared per-check computation (the "row"): given bars up to k, run `liveRead` once and keep
  the read's kind, the features, label (a) and label (b) (Part 4). Rows are stateless per check, so
  they are computed in parallel worker processes over date chunks and cached
  ($SCALP_DESK_HOME/learn/<pair>-<tf>.rows.jsonl). The alert sequence (`shouldAlert`, cooldown,
  `stillRunning`) is then applied serially over the merged rows. **Parity test: the 2026 run from
  rows gives exactly 120 alerts and +0.028R** (legacy both-touched rule, fixed $6, before the
  volume fix).
- `node desk/replay.mjs --pair bitcoin --from 2017-09-01 [--to] [--by-condition] [--list]`.
  Until the final run is recorded it reports **dev years only (to 2024-12-31)**.
- `--by-condition` (developer report): mean R, count and clustered range per condition (regime,
  confidence, H1/H4 agreement, each bucket's sign, hour band 08–10/10–12/12–14/14–16, weekday, side
  = 32 cells), "too few to say" below n = 30, a cell marked "clears zero" only at Bonferroni
  z = 3.16, and the number expected by chance printed next to the number found. Never phrased as
  advice ("avoid…", "only trade…").
- After the volume fix: re-run the 2026 replay and say plainly in HANDOFF if decision 26 moves.

## Part 3 — automatic trade journal

- `desk/journal.json`, committed, allowlisted fields only (rule 6). One entry per alert the method
  sends, with `method` = {METHOD_VERSION, TARGET_RULE, filter: 'none' or a recipe id}.
- Sources of entries: `watch` alerts (as sent); `scan` ideas, which skip shouldAlert, are logged as
  `scan-extra` unless they would pass shouldAlert against the journal's previous entry for that
  pair; and **`journal update` backfills** — it runs `liveRead` over the feed's bars for window bars
  no watcher covered and logs each alert the method would have sent as `unseen`. Deduplicated on
  pair + barCloseMs. Unseen alerts count in the sample but are never shown as missed trades.
- Resolution: silent, from feed bars via `outcome()` (both-touched = half), run by `journal update`
  and at the start of `watch`/`scan`/`now`/`brief` without adding a line to their replies.
- Taken: only by explicit link — a `take` that returned ok, then "took it" within the ticket's
  freshness (30 minutes on M15), or `plan took --alert <id>` when the conversation names the alert.
  Never inferred from recency. `actual` comes only from the user's words; £ is converted to R with
  the risk amount and only R is stored. `account: demo|live` from a new `account.mode` setting
  (default demo); "Your trades" is split by it.
- **The alert sample** is its own field, `journal.json → sample {plannedAlerts, method,
  committedAt}`, never `record.plannedSample` (that stays the user's own MT5 trades in "Is it working
  yet?"). Verdict, declared now: at N alerts, mean R per alert after costs with the by-day clustered
  95% range. Lower bound above 0 → "evidence of an edge, not proof". Upper bound below 0 →
  "evidence against". Otherwise → "not distinguishable from break-even". Before N: the count, and
  outside session hours the average and range, plus the decision-8 sentence. N: detecting +0.2R
  (5% one-sided, 80% power) at sd ≈1.10R per alert, day-clustered, needs about **190 alerts**
  (replaces the binary formula's 240). Ask the user, in these words: "Shall I judge the alerts on the
  next 190 of them, every alert scored on the price feed whether you take it or not, and give no
  verdict before then? Your own trades stay in 'Is it working yet?', separately."
- `journal` after the session: the two blocks (rule 5); no by-condition breakdown of the live
  journal before the committed sample is complete, and after it only descriptively with the chance
  warning. Per-trade facts on request: target / stop / end of session; MFE/MAE in R; bars held; a
  release during the trade; stopped within the first bar.
- The session commits and pushes desk/journal.json after it changes.

## Part 4 — the learning layer

Rows: one per window check (weekday bar closes 08:00–16:00 London), skipping gap-affected windows.

Features (price-free, **signed by the trade side** so "momentum in the trade's direction" is one
feature): engine net, confidence, each bucket score (+ volume abstain flag), regime one-hot,
efficiency ratio, H1/H4 bias scores and agreement; returns over 1/4/16/96 bars ÷ ATR; ATR ÷ price
and its percentile over the last 1,000 bars; close vs EMA21, EMA50, session VWAP ÷ ATR; RSI − 50;
Bollinger %b − 0.5; last bar range ÷ ATR; distance to the nearest level ahead and behind ÷ ATR;
relative volume; hour band one-hot; weekday one-hot. Standardisation (and kNN scaling) is fitted
inside each training fold only.

Labels: (a) the watcher's own trade on the engine's lean (engine stop + 1.5R-when-clear target),
with kind ∈ {idea, rejected, none, blocked} and whether it would have alerted; (b) a standard long
and short from the same bar: stop = max(1.2 × ATR, the engine's noise-scaled minimum), target 1.5R.
Each gross and net, with MFE/MAE, both-touched flagged.

Models (pure JavaScript, deterministic, no new dependencies):
- Ridge regression with the penalty on the **mean** loss, λ ∈ {0.01, 0.1, 1, 10}, with a check that
  predictions actually differ across the grid. Label (b) long and short rows pooled with mirrored
  features and no side intercept. The filter model trains on **all engine-lean checks** with label
  (a), not on alerts only.
- k-nearest-neighbours "similar past setups" for explanation only: k = 200, **at most one neighbour
  per day, days strictly before the moment**, number of distinct days reported. Never validated as a
  predictor, never on a live alert.

Validation — written before any result is seen:
- Development: expanding-window walk-forward, test years 2019–2024, 2-day purge. λ and the filter's
  kept fraction q ∈ {top 75%, 60%, 50%} (quantiles of training-period predicted R) are chosen on
  walk-forward results only; "near-tie" = within one day-clustered SE, preferring larger λ and
  larger q. "What helped / what hurt" is reported as out-of-sample walk-forward mean R per condition
  with day-clustered ranges, never as coefficients.
- **Two pre-declared tests on the holdout, each at z = 2.241** (one-sided 1.25%, Bonferroni over 2):
  - **T1 — filter**: the watcher with the filter applied before `shouldAlert`, simulated live-style.
    Pass only if (a) the kept alerts' day-clustered lower bound of mean R is above 0, AND (b) the
    kept-minus-unfiltered mean R per trade on the same holdout has a day-block-bootstrap lower bound
    above 0, AND (c) at least 140 kept alerts. Always print kept and removed means side by side.
  - **T2 — ranking ("did it learn anything about the charts?")**: across all holdout window checks,
    the day-clustered correlation between side-aligned predicted R and realised label-(b) R. Pass if
    its day-block-bootstrap lower bound is above 0. It never switches anything on.
  - P2 "direction from scratch" (trade the higher-predicted side) is **exploratory only**: reported,
    never a pass/fail, never wired into alerts.
- Power, declared now: effective sd ≈1.10R per alert; at z = 2.241 and 80% power the smallest
  detectable edge is ≈0.20R at n = 280 (all alerts), ≈0.29R at n = 140. Power against a true +0.10R
  is 12–24%. So a fail is worded "could not show an improvement on 2025–26", never "found nothing";
  a pass is worded "held up", noting a pass on this sample overstates the size of the edge.
- Baselines always beside the results, on the same holdout: the unfiltered watcher; and a
  deterministic coin-flip — at each alert, the average of the long and short outcomes with the
  alert's own distances — reported as a paired, day-clustered "watcher minus baseline" difference.
- **If T1 passes**: the model goes to **shadow** — its keep/remove call is recorded on every alert,
  alerts are unchanged, and the kept subset is reported as a second line. Filter-only alerts happen
  only on the user's explicit yes, which starts a new committed sample from zero and freezes the
  filter until it is done. **If T1 fails**: info-only (research report and "similar setups" in the
  journal on request).
- Refits: `learn update` runs only when the user asks (the session may offer it in one line when
  `learn status` says it is due). A refit updates only the history behind "similar setups" and the
  research report; it never changes a filter that decides alerts or one being shadow-scored during a
  committed sample. Its report says "Refitted on more data; not tested on unseen years." What the
  user is told: "Once a month I can add last month's prices to the history the reports use. It does
  not change which alerts you get or how they are checked; those stay fixed until your committed
  sample is done."

Reporting to the user (one result line first):
"**Bitcoin on past prices: [held up / could not show an improvement]**
Held back and never used to build it: 2025 to mid-October 2026 (2026 had already been used to pick
the 1.5R target).
- All alerts: N, on average +x times the risk (range a to b)
- Alerts the filter kept: N, on average …
- Coin-flip side, same stops: on average …
This is a test on past prices, not a forecast. It is not the verdict on your alerts: that still waits
for the N live alerts you committed to."
"Similar setups" wording (journal or on request only): "On bitcoin's 2017–2024 prices, of the 200
moments most like this one (from N different days), 20 in 100 reached the target, 34 hit the stop,
and the rest were closed at the end of the session. On average that is +0.03 times the risk, about
the same as all alerts. That describes the past; it is not a forecast for this trade." Always "in
100", always beside the all-alerts baseline, never "won", never a lone percentage.
Live alert footer, once the replay exists: "_From the live chart, not your screenshot, and not your
broker's price. It has no live record yet, and the decision is yours._"

Gold: the same pipeline; without `TWELVEDATA_API_KEY` every gold step returns need-key with the same
instructions as `scan --pair gold`. No PAXG stand-in.

## Engineering (from the engineering review, 16 Oct)

Measured: the 65 ms a check is not `analyse()` (1–4 ms). About 95% is a new `Intl.DateTimeFormat`
built on every timezone conversion (src/timezone.js `tzOffsetMs`, src/sessions.js `localDate`), and
`getActiveBlackout` runs twice per check (in `gateFor` and in `liveRead`). With formatters cached
per timezone a check takes ~8–10 ms (0 differences on 600 sampled checks); a two-phase replay of
2026 took 18 s on 3 workers, and 2017-09 → 2026-10-14 (75,919 checks) 150 s on 4 workers.

Corrections the review made to the facts above:
- The calendar does not cover 2026 only: rule-derived events (weekly claims, ISM by business day,
  approximate retail sales and flash PMI, month-end expiries, ADP pulse) produce blackouts in every
  year, using 2026 holidays. Only the date-listed tier-1 events are 2026-only. History runs take an
  explicit **calendar mode** (`full` | `rules` | `none`), the same for every year in the dataset and
  learner; each read records the blackout event id. 2026 is reported with `full` only to compare
  with decision 26.
- **Historical cost goes into the read**, not only into `outcome()`: `liveRead` hard-codes the
  observed spread, which feeds the engine's spread verdict, `costFor`, `checkPlan`'s stop floor
  (max 10 × cost, noise) and netR. 2019 with the scaled spread gave 281 ideas against 192 at a fixed
  $6. `liveRead` takes a `spreadNum` override; each read stores the spread it used; cost mode is in
  the read-store key and every report header.
- Rows with no engine read: `blocked` rows never reach `analyse`; `none` rows are mostly neutral
  (no stop or target). A dataset `readAt()` computes features from an `analyse` call made with
  `blackout: null` and a non-dead band (features only), takes the watcher kind from the real path,
  and leaves label (a) null unless the kind is idea or rejected (rejected rows take their levels
  from `toPlan`). Gate-blocked rows are never tradeable. Net and raw confidence are recomputed in
  features.mjs from the buckets and the exported WEIGHTS (or analyse returns them additively).
  Zero-variance features are dropped per pair; sd = 0 is guarded when standardising.
- The filter changes later `stillRunning` and cooldown results, so T1 cannot be computed by
  filtering the unfiltered alert list: the read store keeps every idea read, and the serial alert
  pass takes a predicate applied before `shouldAlert`; the baseline and T1 come from the same pass.

Build order (only one agent edits a shared file at a time):
0. **Foundation (one agent).** Cache formatters (src/timezone.js, src/sessions.js); prove the 2026
   replay is byte-identical; rebuild the page; smoke test. `desk/net.mjs` `ensureProxy()` shared by
   desk.mjs, replay.mjs and the new CLIs. `desk/reads.mjs` (side-effect free): `readAt()` with
   `spreadNum` and `calendar` options, the read for every target rule from one `analyse`, an
   `extra()` hook for features; a worker pool that gives each worker a k-range and the full bar
   array (no warm-up logic: each read is a pure function of bars[k−999..k], nowMs = close + 20 s,
   cfg, rule); the serial alert pass (`shouldAlert` → `alertState` → `outcome`, rebuilding
   `seen = bars.slice(max(0,k−999), k+1)`) with a predicate; a JSONL read store keyed by a hash of
   the engine source, cost mode, calendar mode, window and timeframe. replay.mjs on top, with
   `--workers` (1 takes the same two-phase path), `--cost fixed|scaled`, `--calendar`,
   `--both-touched stop|half`, and holdout discipline (rows from 2025-01-01 only with `--holdout`,
   every such look appended to desk/model.json; the decision-26 window is marked "already seen").
   Parity tests: CLI 2026 at workers 1 and 4 prints exactly 6464 / {none 2600, rejected 3291, idea
   359, blocked 214} / 120 / 24-41-55 / buy 55, sell 65 / +0.028R / −0.169 to 0.225; a unit test
   compares alert lists on test/fixtures/btc-m15.json for workers 1 vs 3. **Then** the volumeBucket
   fix, the 2026 re-run, and the change recorded in HANDOFF decision 26; rebuild and smoke again.
1. **New files only, in parallel:** A `desk/history.mjs` (merge into the cache, never truncate; drop
   the forming bar; refetch from the last cached bar; Twelve Data code 429 → wait 60 s, code 400
   "No data" → stop, dedupe by t; skip checks whose 1,000-bar slice has a gap > 4 bars; stubbed
   fetch in tests). B `desk/features.mjs` (pure function of closed bars, analysis, nowMs, cfg; test
   that the live path and the dataset give the same features at bar k). C `desk/journal.mjs`
   (append-only JSONL event log — alert, ticketed, taken, resolved, actual — natural id
   `${pair}-${barCloseMs}`, idempotent fold; path `$SCALP_DESK_JOURNAL` or `journal.jsonl` beside the
   config so tests are isolated; allowlist test; wording; summary). E `desk/conditions.mjs` (the
   by-condition table). F the 2025 calendar dates (src/news-calendar.js data only).
2. **After B and 0:** D `desk/dataset.mjs` + `desk/learn.mjs` + tests (ridge, kNN, walk-forward, T1
   and T2 via the predicate pass, P2 exploratory, canonical recipe JSON hashed, every `--final`
   attempt recorded in model.json; model.json beside the config like the journal).
3. **Integration (one agent):** desk.mjs (journal and learn commands; now/brief on the proxy path),
   live.mjs (METHOD_VERSION and the method-hash test; journal entries; footer), config
   `account.mode`, SKILL.md, README, HANDOFF, `.gitattributes`
   (`06-scalping-copilot/desk/journal.jsonl merge=union`; the session pulls with rebase before
   pushing); replay on history.mjs. Resolution fetches bounded by `AbortSignal.timeout(~5 s)`, never
   failing the command, on the alert's own feed (history.mjs for entries older than the live window).
4. Then: build the bitcoin read store, run walk-forward on dev years, commit the recipe, run the
   holdout once, review, report.

Keep test/run-all.mjs under ~30 s once the formatter cache lands: fixture-only tests, no more than
~200 liveReads each. JSONL rows (~2 KB, ~150 MB for bitcoin) are read line by line.
