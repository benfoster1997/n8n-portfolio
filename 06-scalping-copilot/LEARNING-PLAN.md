# Plan: history replay, automatic trade journal, and a learning layer

**Status (17 Oct 2026, 06:30 London): built, reviewed, and the bitcoin holdout test has RUN ONCE.**
Recipe committed `8bbbe16` (hash `e7976712…`) before anything held back was computed; armed
`7c7192b`; ran 05:21 UTC, recorded `33136bc`. T1 (filter) did not pass — 200 kept alerts at
−0.070R against 258 unfiltered at −0.022R; status info-only. T2 (ranking) passed its bar only
just (+0.041, lower bound +0.000), driven by the already-seen 2026 (+0.095) not the clean 2025
(−0.003). The held-back years are used; HANDOFF.md "Where we stopped" has the full table.

This is the pre-registration document. Everything below that decides a result was written before
that result was seen. Where the build departed from the 16 Oct text, the change is marked
**As built** with its date and reason; nothing was changed after seeing an outcome it affects.
HANDOFF.md → "Where we stopped" has the state of the work; its decisions 27–29 say why the pieces
are built as they are.

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

## What has been seen before the recipe is committed

Listed so that no development result is later mistaken for a test:
- **Decision 26's plain 2026 report** (1 Jan–11 Oct, default settings) — seen, and used to choose
  the 1.5R rule. Re-run 16 Oct after the corrected February dates (1.5R: 120 alerts, +0.029R) and
  17 Oct after the 999-bar change (byte-identical). 2026 is "already seen" in every result.
- **Two `--calendar rules` looks at 2026 rows** (16 Oct, to check the calendar correction),
  recorded in a scratch model file, not desk/model.json: 1.5R 120 alerts, +0.029R.
- **A walk-forward on development years only** (scratch run, 17 Oct; no row from 2025 on was
  read): chosen λ 10, q 0.75 by the near-tie rule (the best single setting was λ 1, q 0.5 at
  +0.040R). Pooled 2019–2024: unfiltered 723 alerts at −0.011R; kept 540 at +0.009R; removed 190
  at −0.067R (kept + removed exceed unfiltered because removing an alert frees later ones from the
  cooldown and "still running"). Ranking correlation +0.04 to +0.08 a year. Nothing was committed
  from it; the real fit is run again and committed as the recipe, and what it prints is what stands.
- **2025** — no run that reports an outcome has read it, as far as the record shows (HANDOFF,
  commit messages, model files).

## Facts the design rests on (measured)

- Watcher: desk/live.mjs `liveRead()` = gate → `analyse()` on the last 300 closed M15 bars with
  `htfBars` from the last **999 closed bars** (`CLOSED_BARS = FETCH_BARS − 1`: the 1,000-bar fetch
  holds the bar still forming; the history path reads the same 999 since 17 Oct, and the 2026
  replay is byte-identical) → `toPlan()` → `checkPlan()`. Alerts pass `shouldAlert()` (no repeat
  bar; 4-bar same-side cooldown; not while the previous alert is `stillRunning`).
  `TARGET_RULE = '1.5R'`.
- 2026 replay (1 Jan–11 Oct; re-run twice on 16 Oct, identical): 6,464 checks; reads none 2,600 /
  rejected 3,291 / idea 359 / blocked 214; 120 alerts; +0.028R a trade; sd 1.06R; clustered 95%
  −0.169..+0.225; target 24 / stop 41 / window 55; buys 55 at −0.038R, sells 65 at +0.084R.
  ≈65 ms a check single-threaded; 4 CPUs, 15 GB. *After the corrected February dates (16 Oct):
  rejected 3,288 / idea 362; +0.029R; clustered −0.168..+0.226 (HANDOFF decision 26).*
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
- Gold needs `TWELVEDATA_API_KEY` (not set as of 17 Oct). The calendar's dated tier-1 table covered
  2026 only on 16 Oct; 2025 in full and the sourced 2017–2024 dates were added the same day
  (decision 4). Rule-based tier-2 events compute for any year using 2026 holidays.
- The `volumeBucket` quirk (it read `lastOf(relVol)` instead of the newest bar) was fixed 16 Oct
  before anything was frozen; it moved nothing (decision 26).

## Rules that bind every part

1. **One method per committed sample.** Turning on, refitting or replacing a filter, or changing the
   engine, the checks or the target rule, ends the sample in progress. The desk says so and asks
   first. The alert method has a `METHOD_VERSION` and a test that hashes the files that decide
   alerts; changing them without a conscious bump fails the test.
   **As built:** `METHOD_VERSION = 1` in desk/live.mjs; test/method.test.mjs hashes the engine,
   indicators, shot (checks and gate), sessions, timezone, timeframes, instruments, live.mjs,
   outcome.mjs, and single functions where a file is mostly wording (lib.mjs `gateFor`, `costFor`,
   `serverOffsetFor`, `timeframeFor`; data-feeds `closedBars`; two risk.js functions).
   src/news-calendar.js is deliberately not hashed (data, not rule); a change to how blackouts are
   *derived* needs a bump by hand. The journal's method also holds the timeframe, the reference
   feeds, the window and the costs, so changing those settings makes a different method too; the
   broker's server offset does not (Part 3). **As built (final review, 17 Oct):** while a sample is
   running, `config` refuses such a change and says, in plain words, that it ends the sample for good
   with no verdict; only `config … --end-sample` (the user's yes) applies it, and the journal records
   the end as an `ended` event (reason `method-changed`), so a change undone at once has still ended
   it. **Only an `ended` event ends a sample.** A change made outside `config` (a hand edit, a pulled
   config) or a new `METHOD_VERSION` **pauses** it: no update records a day for it and nothing is
   counted while the method differs; `journal` says so and that the user can change the settings
   back or end it (`config --end-sample`); put back, it carries on.
2. **The holdout is looked at once.** Fixed window: 2025-01-01 00:00 UTC → 2026-10-14 20:45 UTC.
   The full recipe is committed to desk/model.json *before* any run reports a held-back row.
   2025 (clean) and 2026 (seen while choosing the 1.5R rule) are always reported separately.
   **As built (16–17 Oct):** the replay reports held-back rows only with `--holdout`, and every
   such look is appended to desk/model.json under `looks`; the one exception is the plain report of
   decision 26's 2026 stretch at default settings, labelled "already seen" — default meaning
   decision 26's own: M15, the default window and broker block, the commission from the
   specification, cost fixed, calendar full, both-touched stop (on M5, say, those rows are unseen). The dataset holds no
   held-back label unless built with `--holdout` (its own file, recorded as a look). The final is
   two steps (Part 4); a result after any recorded look says "The held-back years have already been
   used once; this result is not on unseen data." and cannot set status shadow. A second final for
   the window is refused outright, and so is any refit after one.
3. **Nothing about the learner on a live alert or a push**, in any mode. No number, no "similar
   setups". The model can only *remove* engine alerts, never propose a side, never bypass the gate,
   the dead zone, blackouts, `checkPlan()` or sizing. **As built:** the learner reaches the user
   only through `learn status`, `learn report` and `learn similar`, each run only when asked.
4. **No running results in session.** Journal resolution is silent. Between 08:00 and 16:00 London
   on a weekday, `journal` gives process counts only plus: "Results are shown once your session is
   over; checking them mid-session tends to make the next decision worse." A direct question about
   one named alert is answered in R.
5. **Wording.** An alert's outcome is said one of three ways: "The 10:15 bitcoin sell alert reached
   its target (+1.5 times the risk)", "…hit its stop (−1)", "…was closed at the end of the session
   (+0.3)". Never "won", "lost", "you made", never £, never a feed-price level. Summaries are two
   blocks never added together: "**The alerts**: scored on Binance's prices, not your MT5 trades;
   your own result can differ." and "**Your trades**: what you told me (n of them)."
   **Declared additions (17 Oct, before any alert):** "…touched its stop and its target in the same
   bar, so it counts as half of each (+0.14)" and "…has not finished yet". A result across a gap in
   the feed adds a clause to one of the forms, not a new form.
6. **Privacy (public repo).** desk/journal.jsonl holds only an allowlist of fields, enforced by
   `sanitize()` and a test; a forbidden key at any depth throws. **As built**, allowed: id, at,
   pair, tf, bar close and valid-until times, side, feed name and id, refPrice, stop and target
   distances, spread and commission *as price distances*, netR, confidence, engine reasons/against
   text, features (names from features.mjs only), filter output {id, keep, predicted}, outcome in R
   with path (bars, MFE, MAE, both-touched, gap), source (watch | scan), ticketed {userPrice,
   stopLoss, takeProfit}, taken {how}, actual {r, how ∈ target | stop | by-hand | end-of-session},
   account mode, method {version, targetRule, filter, tf, feeds, window, costs}, day records,
   the sample, its end (reason only) and the consent answer. Never: volume or lots, any money amount, balance, risk %,
   account number, login, server, email, phone, or free text from the user or a screenshot; engine
   text is also refused if it holds a currency amount, an email address or a long digit run. Before
   the first entry with account mode `live`, ask once whether a live trade record may sit in a
   public repository (and point out that config.json's balance would be public too; a shadow balance
   avoids that). Until the answer is yes, live events are refused at the one writer.
7. **Only what the live desk could have sent reaches the user.** User-facing reports cover rows of
   kind `idea` with the gate open (gold outside the dead zone; 2026 rows outside blackouts). Other
   rows (rejected, dead zone, blackouts) are developer-only; if they look better, that goes in
   HANDOFF as a candidate rule change needing its own sample — never a tip.
8. **Multi-year caveat** in every multi-year report: "Before 2025 there is no news calendar, so these
   years include trades around releases that the live desk would have sat out." **As built:** the
   learner trains under calendar `rules`, which holds no dated release in any year, so the sentence
   is exact for its rows; the replay's own header says what the 2017–2024 tables do hold.

## Part 1 — shared pieces

- `desk/outcome.mjs` (done 16 Oct): `outcome()` moved out of replay.mjs unchanged in behaviour,
  plus MFE/MAE in R and a `bothTouched` flag. Scoring option `bothTouched: 'half'` scores such a
  bar as the average of target and stop (and, since 17 Oct, returns how `'both'`); reports state
  how many there were. The replay's legacy "stop" rule stays the default so decision 26's figures
  still reproduce.
- `desk/history.mjs` (built 16–17 Oct): `loadHistory(pair, tf, {home, fromMs, toMs, fetchImpl,
  signal, deadlineMs})` → closed bars, cached under `$SCALP_DESK_HOME/history/`, merged in and
  never truncated, extended only at the missing ends; a sidecar `<PAIR>-<TF>.meta.json` says which
  last bar this module saved as final (else it is fetched again). BTCUSD: Binance klines, 1,000 a
  call. XAUUSD: Twelve Data `interval=15min&timezone=UTC&outputsize=5000`, paging backwards, ≥ 8 s
  between calls, key in a header; a per-minute refusal waits 60 s, a per-day one stops; without a
  key `{needKey:true}`. Reports coverage and gaps; gold's scheduled closures are told apart from
  missing data by the New York clock. **Known limit:** a whole Friday or Monday lost beside a
  weekend has the shape of a holiday weekend and is read as one (no holiday table). Checks whose
  999-bar slice holds a gap of more than 4 bars are skipped (read kind `gap`).
- Costs: train on **gross** R (spread 0, no commission); predict gross and subtract the decision-time
  cost in R. **The holdout test uses, per trade, the more pessimistic of the fixed figure and the
  scaled one.** **As built:** cost modes `fixed` (bitcoin $6), `scaled` (6 × close / 84,400) and
  `max` (per check the larger of the two, in the read and in the outcome); training rows use
  `scaled`, the holdout `max`; the commission comes from the config in every mode. **Not built:**
  gold's scaled spread (no reference price yet; gold waits for its key anyway) and the 2× / 3× bps
  sensitivity runs for pre-2023 years.
- News calendar (done 16 Oct): 2025 tier-1 US dates and holidays with the shutdown's delays as they
  happened, and the 2017–2024 dates a source confirmed (FOMC complete; NFP and CPI partial), from
  data/calendar-history.json. Table-driven only (decision 4).

## Part 2 — multi-year replay with reasons

- One shared per-check computation: given bars up to k, run `liveRead` once. **As built:**
  desk/reads.mjs computes every check's read in worker threads (all three target rules from one
  engine run) and keeps them in a read store, `$SCALP_DESK_HOME/learn/<PAIR>-<TF>-<key>.reads.jsonl`,
  keyed by the engine's source, cost mode, calendar mode, window and timeframe, each read carrying
  a fingerprint of its slice. The alert sequence (`shouldAlert`, cooldown, `stillRunning`) is then
  applied serially, with an optional predicate before `shouldAlert`. Labels are added by the
  dataset (Part 4). **Parity met (16 Oct):** the 2026 run gives exactly 120 alerts and +0.028R at
  `--workers 1` and `--workers 4` (legacy both-touched rule, fixed $6, before the volume fix);
  +0.029R after the February correction; byte-identical after the 999-bar change (17 Oct).
- `node desk/replay.mjs --pair bitcoin --from 2017-09-01 [--to] [--rule level|1.5R|2R] [--workers N]
  [--cost fixed|scaled] [--calendar full|rules|none] [--both-touched stop|half] [--holdout]
  [--by-condition] [--list] [--no-store]`. Bars come through history.mjs. Until the final run it
  reports **dev years only (to 2024-12-31)** unless `--holdout` (recorded; rule 2).
- `--by-condition` (developer report; desk/conditions.mjs): mean R, count and clustered range per
  condition. **As built: 30 cells** — regime 4, confidence 3, H1/H4 agree / do not agree 2, the
  five directional buckets with / against the trade 10, hour band (08–10, 10–12, 12–14, 14–16
  London) 4, weekday 5, side 2. There is no volatility bucket: volatility has no direction, so
  "with" and "against" mean nothing for it (the 16 Oct text said 32). "Too few to say" below n = 30
  or fewer than 10 days. A cell is marked "clears zero" only at the Bonferroni level over the 30
  cells, taken as a **Student-t(G − 1) quantile on the cell's number of days G, with the G/(G − 1)
  factor on its day-clustered error**; the plain z ≈ 3.14 is that level only for a cell on many
  days. The number expected to clear 95% by chance is printed next to the number found. Periods
  (development, 2025, 2026 seen, after the holdout) are never mixed in one table; rows after the
  holdout are refused until the live sample is complete. Never phrased as advice ("avoid…",
  "only trade…").
- After the volume fix: the 2026 replay was re-run; decision 26 did not move.

## Part 3 — automatic trade journal

**As built (16–17 Oct), after review.** The 16 Oct design counted the watcher's alerts plus a
backfill of bars "nobody watched"; which alerts made the sample then depended on which writer ran
first and on watcher state living in one container. The committed sample is now **the method's
own record, replayed on the reference feed**, the same whoever runs it, wherever.

- **The file**: `desk/journal.jsonl` (not journal.json), committed: an append-only log of JSON
  lines, folded into entries by each event's own fields, so line order (a git union merge, a pull
  with rebase) cannot change history. Written under a lock, then a temporary file renamed over the
  old one. Beside the config, or `$SCALP_DESK_JOURNAL`, so tests never touch the real one.
  `.gitattributes` gives it `merge=union`; the session commits it, then pulls with rebase, then
  pushes (git refuses a pull with rebase over changes not committed).
- **Ids**: `${pair}-${tf}-${barCloseMs}` — e.g. `BTCUSD-M15-1792401300000`, the bar closing 10:15
  London on 19 Oct 2026. The timeframe is in the id because 10:15 closes an M5 bar and an M15 bar
  alike.
- **Event types**: `alert` and `day` (the method's record); `shown` (what the user was sent);
  `resolved`; `ticketed`; `taken`; `actual`; `sample`; `ended` (a sample the user agreed to end — the
  only way one ends); `consent`.
- **The method's record** (`journal update`): replays the method — `liveRead` and `shouldAlert` at
  close + 20 s — over every weekday window bar close on the reference feed (bitcoin: Binance
  BTCUSDT, from either Binance host; gold: Twelve Data; fallback feeds are refused), serially, and
  scores each alert with `outcome()` (both touched = half). Whole days only; each day gets a `day`
  record listing its alert ids with a checksum of each line, and **a recorded day is frozen**. The
  method is {version, target rule, filter, timeframe, reference feeds, window, costs}, keyed per
  instrument (its own feed and costs). The record never reads the held-back years: `alert`,
  `shown` and `day` events at or before 2026-10-14 20:45 UTC are refused.
- **What the user was shown** (`shown`): each `watch` alert as sent and each `scan` idea (the
  plan's "scan-extra"), with the method and the features of that read. Never the sample; a watch
  record outranks a scan of the same bar. A method alert with no `shown` event is one the user was
  not sent — never "a missed trade". A read from a test stand-in feed is not recorded.
- **Resolution**: silent. `journal update` scores what the user was shown; a time-limited update
  (about 5 s, one day at a time) also runs at the start of `watch`, `scan`, `now`, `brief` and
  `journal`, never adds a line to their replies and can never fail the command (`watch` prints
  what it watches first). Each shown alert is scored on its own timeframe's bars, whatever the
  setting says now; bars of another timeframe leave it unscored rather than scored wrongly.
- **Taken**: only by explicit link. `take` records `ticketed` (the user's MT5 price, stop loss and
  take profit only). `plan took` marks `taken` only through the one ticket built within the
  ticket's freshness (30 minutes on M15) or an alert named with `--alert` (an id, `last`, or its
  London time; `--pair` when two share a time); with two fresh tickets the desk asks and the session
  runs `journal took`. Never inferred from recency; `plan undo` does not unmark (append-only).
  `actual` comes only from the user's words: `--r`, `--how stop|target|manual|end` (stop = −1,
  target = the alert's own netR), or `--pounds P --risk X` (R = P / X; neither number stored).
  **As built (final review, 17 Oct):** for a trade, `last` means the newest alert with a ticket or
  a "took it" — never a scan idea or an alert nobody acted on — and two still open make the desk
  ask; `last` and a London time reach back only to today or the last 24 hours, and an older alert
  is named with its day and needs its id. On a live account without a yes (rule 6) the desk says
  that nothing live is kept, or asks the question, instead of asking which alert.
- **Account**: `account.mode` (demo | live, default demo; `config account=`). "Your trades" is split
  by it. When the alert was shown under the other mode the desk asks which account the trade was
  on, holding the mark 2 hours in `$SCALP_DESK_HOME/journal-pending.json`; `journal account
  demo|live` applies the answer — to a ticket, a "took it" made while the ticket waits, and a
  result alike. `config livejournal=yes|no` records the rule-6 answer as a
  `consent` event.
- **The alert sample** is its own event, `sample {plannedAlerts, method, pairs, committedAt,
  replaces}`, never `record.plannedSample` (that stays the user's own MT5 trades in "Is it working
  yet?"). Verdict, declared 16 Oct: at N alerts, mean R per alert after costs with the by-day
  clustered 95% range (with the G/(G − 1) factor). Lower bound above 0 → "evidence of an edge, not
  proof". Upper bound below 0 → "evidence against". Otherwise → "not distinguishable from
  break-even". Before N: the count, and outside session hours the average and range so far, plus
  the decision-8 sentence. **N, settled 17 Oct before any sample was committed:** the verdict is
  the two-sided 95% range of mean R per alert, so "lower bound above 0" is a 2.5% one-sided test;
  80% power against a true +0.2R at sd ≈1.10R per alert needs n = ((1.96 + 0.842) × 1.10 / 0.2)²
  ≈ 238, so **240 alerts**. (The 16 Oct text said 190, sized at 5% one-sided: about 70% power for
  the verdict as declared.) Ask the user, in these words: "Shall I judge the alerts on the next 240
  of them, every alert scored on the price feed whether you take it or not, and give no verdict
  before then? Your own trades stay in 'Is it working yet?', separately." (`journal sample` prints
  it; `journal sample --alerts N` commits, bitcoin by default, gold too when a key exists.)

**DECLARED RULES** — fixed 17 Oct, before the first alert is recorded (desk/journal.mjs header):
- `MIN_PLANNED_ALERTS = 100`: no sample is committed below 100 alerts (`DEFAULT_PLANNED_ALERTS =
  240`, the size above).
- `MIN_VERDICT_DAYS = 30`: no verdict until the judged alerts span 30 London days; if the first N
  span fewer, the judged set runs on to the END of the 30th distinct day, every alert of it — a rule
  on dates alone, never on results.
- Outcomes are said in rule 5's three forms plus its two declared additions.
- Holed days: a day with any bar missing (outside gold's scheduled closures) is held up to 48 h
  after its window closes, then recorded as it stands; if a hole is of more than 4 bars it is
  flagged `gap` and its alerts are left out of the sample (so is any alert whose own trade spans a
  gap).
- The sample ends (`method-changed`) only at an `ended` event, written when the user agrees to end
  it (`config … --end-sample`). While the method the desk runs differs from the sample's for one of
  its instruments — version, target rule, filter, timeframe, window, or that instrument's reference
  feed or costs, changed outside `config` — the sample is **paused**: no day is recorded for it and
  nothing is counted until they match again, when the days in between are recorded like any other.
  A day, alert or shown alert under another method never ends it. The server offset is not in the
  key; a day with a read outside the broker's session is never recorded instead. A verdict reached
  before the end is kept.
- Contested days (two records of one day that differ in their alert ids, checksums or gap flag —
  a merge) withhold the verdict while any falls on or before the last judged alert; they are
  settled by hand.
- Every weekday from the commitment to the last judged alert must be recorded for every instrument
  in the sample before a verdict.
- Notes: a sample in progress (running or paused) cannot be replaced; a sample that has
  ended (the user agreed, even if the setting was changed back since) can be followed by a new one at once
  (final review, 17 Oct: the desk had refused, and no sample could be committed again); run a pull before
  `journal update`, so contested days stay rare; a scan's ideas are never the sample, whether or
  not they would have passed `shouldAlert`; a journal written before commit `9e5f123` must be
  discarded and recorded again (none exists anywhere).

**Settled 17 Oct, before `journal sample` was ever run:** the verdict's range is two-sided 95%, so
"lower bound above 0" is a 2.5% one-sided test, and N = 190 (sized at 5% one-sided) gave it only
about 70% power against a true +0.2R. N is now **240** (80% power for the verdict as declared,
above); the verdict rule itself is unchanged. `MIN_PLANNED_ALERTS` stays 100.

- `journal` after the session: the two blocks (rule 5), then the sample. No by-condition breakdown
  of the live journal: no command offers one, and conditions.mjs refuses rows after the holdout
  until the sample is complete (afterwards only descriptively, with the chance warning). Per-trade
  facts on request (`journal alert`): the outcome form, MFE/MAE in R, bars held. **Not built:** "a
  release during the trade" and "stopped within the first bar" (bars held = 1 shows the latter).
- The session commits desk/journal.jsonl after it changes, then pulls with rebase, then pushes (a
  NOTE from the desk says when; the silent update writes without one, so the daily routine commits
  first too).

## Part 4 — the learning layer

**Rows** (desk/dataset.mjs, built 17 Oct): one per window check (weekday bar closes 08:00–16:00
London); kind idea | rejected | none | blocked | gap | no-data | stale (the last three carry no
features). A trade whose path crosses a hole of more than 4 bars keeps its levels but no score
(`gapAhead`), and is left out of training and of every alert pass.
- **File**: `$SCALP_DESK_HOME/learn/<PAIR>-<TF>-<cost>-<calendar>-<rowsKey>.rows.jsonl` (training:
  `BTCUSD-M15-scaled-rules-<rowsKey>`), with `<rows file>.manifest.json` beside it: {fromMs, toMs,
  firstCloseMs, lastCloseMs, rows, sha256, rowsKey, storeKey, settings {pair, tf, cost, calendar},
  source, holdout, featuresVersion, labelVersion, builtAt}. rowsKey hashes the read-store key,
  FEATURES_VERSION, the label version and the source of outcome.mjs and dataset.mjs. The learner
  refuses rows with no manifest, another hash, or a rowsKey today's code would not give; a narrower
  build never replaces a wider one without `--replace`.
- **Held-back years**: the dataset never holds a held-back label by default — `--to` defaults to
  2024-12-31 and checks closing on or after 2025-01-01 are refused without `--holdout`. A
  `--holdout` build goes to its own file (a `-holdout-` segment in the name), is recorded as a look
  in desk/model.json, and prints the held-back rows' number only. The final never uses those rows.
- **Calendar (decision D1, lead, 17 Oct, before any recipe):** training and walk-forward rows use
  calendar `rules`, the same in every development year (2017–2024's tier-1 tables are incomplete);
  the one held-back evaluation uses `full`, the live desk's calendar. Features never depend on the
  calendar; only which checks are tradeable does.

**Features** (as built, FEATURES_VERSION 1, 47 names; price-free; market-direction signed, turned
"for the trade" by `sideSigned()` so long and short rows pool with mirrored features):
- the engine's read, recomputed for every state: net, confidence, the five directional bucket
  scores and a volume-abstain flag;
- volatility (directionless): the volatility bucket, `log_atr_change_1h` (log of ATR now ÷ ATR an
  hour earlier), Bollinger width percentile, ADX, ATR ÷ price, and its percentile — a plain 14-bar
  mean of true range over price ranked among the last **960** such values (`ATR_RANK_BARS`: ten
  days of M15, the most a 999-bar history fills, so live and dataset rank alike);
- regime one-hot (trending, ranging, compressed, mixed) and the efficiency ratio;
- H1 and H4 bias scores and their agreement;
- returns over 1/4/16/96 bars ÷ ATR; close vs EMA21, EMA50 and session VWAP ÷ ATR; RSI − 50;
  Bollinger %b − 0.5; last bar range and body ÷ ATR;
- distance to the nearest level ahead and behind ÷ ATR, with a flag when there is none (ahead and
  behind swap for a sell);
- `log_rel_volume` (log of relative volume, floored at 0.01);
- hour band one-hot and weekday one-hot (London).
The heavy-tailed distances (returns, close-vs, levels) are clipped at each training fold's own 1st
and 99th percentiles; standardisation is fitted inside each training fold only; a feature with no
spread in a fold is dropped; a null becomes the fold's mean.

**Labels**: (a) the watcher's own trade on the engine's lean (the read's 1.5R-rule stop and first
target; rejected rows from `toPlan`), on kinds idea and rejected only, with whether it would have
alerted; (b) a standard long and short from the same bar: stop = max(1.2 × ATR, the engine's
noise-scaled minimum), target 1.5R. Each gross and net, both-touched scored half. **As built:**
label (a) keeps its path (bars, MFE, MAE); **label (b) keeps the result only** (r, how).

Models (pure JavaScript, deterministic, no new dependencies):
- Ridge regression with the penalty on the **mean** loss, λ ∈ {0.01, 0.1, 1, 10}, exact Cholesky
  solve, intercept unpenalised. The **filter** trains on all engine-lean checks (idea and
  rejected) with label (a), gross, features signed by the lean's side; predicted net = predicted
  gross − (spread + commission) ÷ stop at the decision; it keeps an alert when the prediction is at
  or above the (1 − q) quantile of training-period predicted net R over training checks the
  unfiltered watcher alerted on. The **ranking** model trains on label (b), long and short rows
  pooled with mirrored features, one intercept, no side term.
- k-nearest-neighbours "similar past setups" for explanation only: k = 200, **at most one neighbour
  per day, days strictly before the moment**, scaling fitted on the candidates, number of distinct
  days reported; each neighbour scored by label (b) on the side asked, net. Never validated as a
  predictor, never on a live alert.

Validation — written before any result is seen:
- Development: expanding-window walk-forward, test years 2019–2024, 2-day purge (training ends the
  London day before 1 January of the test year, minus the purge). λ and the filter's kept fraction
  q ∈ {top 75%, 60%, 50%} are chosen on walk-forward results only, scored as the mean net R of kept
  alerts **through the alert sequence** (the predicate pass, not by deleting rows); "near-tie" =
  within one day-clustered SE (× √(G/(G − 1))) of the best, preferring larger λ, then larger q.
  The final models are refitted on every development day before 2025-01-01 minus the purge, at the
  chosen λ, with both thresholds from those rows. "What helped / what hurt" is reported as
  out-of-sample walk-forward mean R per condition with day-clustered ranges, never as coefficients.
- **Two pre-declared tests on the holdout, each at z = 2.241** (one-sided 1.25%, Bonferroni over 2):
  - **T1 — filter**: the watcher with the filter applied before `shouldAlert`, simulated live-style.
    Pass only if (a) the kept alerts' day-clustered lower bound of mean R is above 0, AND (b) the
    kept-minus-unfiltered mean R per trade on the same holdout has a day-block-bootstrap lower bound
    above 0, AND (c) at least 140 kept alerts. Always print kept and removed means side by side.
  - **T2 — ranking ("did it learn anything about the charts?")**: across all holdout window checks,
    the day-clustered correlation between side-aligned predicted R and realised label-(b) R. Pass if
    its day-block-bootstrap lower bound is above 0. It never switches anything on.
  - Bootstrap: 2,000 resamples of London days, the 1.25% quantile as the lower bound, seeds
    20261016 (T1) and 20261017 (T2).
  - P2 "direction from scratch" is **exploratory only**: reported, never a pass/fail, never wired
    into alerts. **Its threshold rule (proposed in review, confirmed by the lead 17 Oct, before any
    recipe):** trade the higher-predicted side, one position at a time, gate-open checks only, where
    that side's predicted net R is at or above the (1 − share) quantile of the higher-side
    prediction over gate-open training checks, with share = (gate-open training checks the
    unfiltered watcher alerted on ÷ gate-open training checks) × q — so P2 is offered about as many
    checks as the kept filter, on the ranking model's own scale. Fixed once a recipe is committed.
- Power, declared now: effective sd ≈1.10R per alert; at z = 2.241 and 80% power the smallest
  detectable edge is ≈0.20R at n = 280 (all alerts), ≈0.29R at n = 140. Power against a true +0.10R
  is 12–24%. So a fail is worded "could not show an improvement on 2025–26", never "found nothing";
  a pass is worded "held up", noting a pass on this sample overstates the size of the edge.
- Baselines always beside the results, on the same holdout: the unfiltered watcher; and a
  deterministic coin-flip — at each alert, the average of the long and short outcomes with the
  alert's own distances — reported as a paired, day-clustered "watcher minus baseline" difference.
- **The held-back evaluation (as built):** reads computed by the final itself (never dataset rows)
  at cost `max`, calendar `full`, rule 1.5R. Before anything is recorded: at least 1,000 bars before
  2025-01-01, at most 1% of the expected window checks without a bar, at most 2% read as gap,
  no-data or stale — none of which sees an outcome.
- **The final (as built, two steps, only on `desk/model.json`):**
  1. `node desk/learn.mjs final --pair bitcoin` arms it: the recipe still matches today's code and
     config, every method file is committed and clean, model.json is committed at HEAD, the bars
     rise strictly and cover the window, and the held-back reads are complete — no outcome is
     computed. It records an `armed` entry (code commit, reads hash). **Commit model.json.**
  2. `node desk/learn.mjs final --run --pair bitcoin` refuses unless that entry is in the committed
     model.json and the reads are the ones armed. Under a lock in `$SCALP_DESK_HOME` and another in
     the git common dir, it writes `started` to model.json and to **three logs** —
     `$SCALP_DESK_HOME/learn/finals.log`; `~/.scalp-desk/learn/finals.log` with ~ the account's home
     from the system, not `$HOME`; and `<git common dir>/scalp-desk-finals.log` — immediately
     before the first outcome, then `ran` with the results (or `crashed`). **Commit model.json at
     once.** A run cut short after `started` still counts as the one look. The reads hash leaves
     out each read's index into its bar array (the whole cached file with workers, the loaded
     window without): closeMs and the slice's fingerprint pin each read.
  - A final that started or ran for an overlapping window, in any committed version of model.json,
    the working copy or any log, refuses every later final and every refit. `fit` and `final` work
    only on `<project>/desk/model.json` (`--test-model` names another for scratch fits only; `final`
    refuses it), and refuse in a shallow clone (`git fetch --unshallow` first). A refusal by the
    arm or the run step is itself recorded in model.json.
- **If T1 passes** (and no look at the window is recorded in desk/model.json): status **shadow** —
  its keep/remove call is to be recorded on every alert, alerts unchanged, and the kept subset
  reported as a second line. Filter-only alerts happen only on the user's explicit yes, which starts
  a new committed sample from zero and freezes the filter until it is done. **If T1 fails**:
  **info-only** (research report and "similar setups" on request). **As built:** the final writes
  the status into model.json; recording the shadow call on each alert (canonicalAlerts already
  takes a `filterFor` hook and the allowlist has the `filter` field) is **not built** — it is built
  only if T1 passes.
- **Refits.** The 16 Oct text planned a monthly `learn update` that refreshed the history behind
  "similar setups". **As built: there is no `learn update`.** `fit` is a developer command, run only
  when HANDOFF's plan says so, and after any final it refuses ("Refitting now would be a new method
  on data already seen"). "Similar setups" therefore draws on the development rows (2017–2024) only.
  A refresh would need its own rule — a separate history that decides nothing — declared here before
  it is built. Until then the session must not tell the user it can add last month's prices.

Reporting to the user (one result line first; `learn report`, as built):
"**Bitcoin on past prices: [held up / could not show an improvement]**
Held back and never used to build it: 2025 to mid-October 2026 (2026 had already been used to pick
the 1.5R target).
- All alerts: N, on average +x times the risk (range a to b)
- Alerts the filter kept: N, on average …
- Coin-flip side, same stops: on average …
  2025 alone: …; 2026 alone (already seen): …
This is a test on past prices, not a forecast. It is not the verdict on your alerts: that still waits
for the N live alerts you committed to."
Before the final: "**Bitcoin on past prices: not tested yet**"; a final that started and did not
finish: "the held-back test did not finish", and the held-back years count as used.
"Similar setups" wording (on request only; `learn similar --at <UTC bar close> --side buy|sell`): "On bitcoin's
2017–2024 prices, of the 200 moments most like this one (from N different days), for a standard
buy, 20 in 100 reached the target, 34 hit the stop, and the rest were closed at the end of the
session. On average that is +0.03 times the risk, about the same as a standard buy at every earlier
moment (+0.02). That describes the past; it is not a forecast for this trade." plus rule 8's
caveat. Always "in 100", always beside the baseline (**as built:** the same standard trade, same
side, over every earlier moment — the 16 Oct text said "all alerts"), never "won", never a lone
percentage. **The side (final review, 17 Oct; settled the same day):** one standard trade, on the
side the user named. When they named none the desk asks — "Similar setups describe one standard
trade. Which side are you thinking of — buy or sell?" — and shows nothing until they answer; it
never shows both sides at once (side by side, the better figure reads as a lean) and never uses
the engine's lean (on a rejected idea or a closed gate it is a direction the desk withheld, rule 3
and decisions 2 and 22). The developer command needs `--side` as well. Moments inside 2025 → 14 Oct 2026 are refused; earlier moments come from the rows file,
later ones from the reference feed's bars.
Live alert footer (built 17 Oct): "_From the live chart, not your screenshot, and not your broker's
price. It has no live record yet, and the decision is yours._"

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
  features.mjs from the buckets and the exported WEIGHTS. Zero-variance features are dropped per
  fold; sd = 0 is guarded when standardising.
- The filter changes later `stillRunning` and cooldown results, so T1 cannot be computed by
  filtering the unfiltered alert list: the read store keeps every idea read, and the serial alert
  pass takes a predicate applied before `shouldAlert`; the baseline and T1 come from the same pass.

Build order — **steps 0–3 done 17 Oct; step 4 is next** (only one agent edits a shared file at a
time):
0. **Foundation.** Formatter cache; `desk/net.mjs` `ensureProxy()`; `desk/reads.mjs` (each read a
   pure function of the 999 closed bars ending at the check, nowMs = close + 20 s, cfg, rule; the
   serial alert pass with a predicate; the read store); replay.mjs on top with `--workers`,
   `--cost`, `--calendar`, `--both-touched` and holdout discipline; parity at workers 1 and 4;
   then the volumeBucket fix and the 2026 re-run (decision 26). Done 16 Oct (`df60b1f`, `f413203`).
1. **New files, in parallel:** A `desk/history.mjs`; B `desk/features.mjs`; C `desk/journal.mjs`;
   E `desk/conditions.mjs`; F the 2017–2025 calendar dates. Done 16–17 Oct, each re-checked.
2. **After B and 0:** D `desk/dataset.mjs` + `desk/learn.mjs` (+ `desk/features-extra.mjs`, the
   reads' features hook) + tests. Done 17 Oct (`956c6f0`).
3. **Integration:** desk.mjs `journal` and `learn` commands, now/brief/journal/learn on the proxy
   path; live.mjs METHOD_VERSION, the method-hash test, journal entries, the footer, 999 closed
   bars; config `account.mode` and `livejournal`; `.gitattributes`; replay on history.mjs and the
   `conditionReport` adapter; SKILL.md, README, HANDOFF. Done 17 Oct (`87ed32f`).
4. **Next:** build the bitcoin rows, run `fit` on dev years and commit the recipe in desk/model.json,
   arm the final and commit, run it once and commit, review, report in the shape above.

The unit suites run in parallel (`test/run-all.mjs`, ~45 s for 745 assertions in 21 suites; a
failing suite shows its stderr, and one that hangs is killed after 5 minutes and named):
fixture-only tests, no network. JSONL rows (~2 KB, ~110–150 MB for bitcoin) are read line by line.
