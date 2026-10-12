# Handoff — M5 Scalp Desk

Everything needed to pick this up in a fresh session without re-deriving it.
Last updated 12 October 2026. Read this whole file before changing anything —
several decisions below look like mistakes and are not.

---

## Where things are

| | |
|---|---|
| Code | `06-scalping-copilot/` in this repo |
| Branch | `claude/xauusd-btcusd-chart-analysis-8pvje5` — pushed, **no PR opened** (never asked for one) |
| Live page | https://claude.ai/artifact/R1FY8JSKruN8kvhu7XQ3B9 (private to the user) |
| Shipped file | `06-scalping-copilot/index.html`, **generated** by `node build.mjs` from `src/` — never edit it directly |
| In the chat | `06-scalping-copilot/desk/` + `.claude/skills/scalp-desk/SKILL.md` — the session runs it when the user sends a screenshot |

### Republishing the page from a new conversation

A new conversation did not publish this artifact, so the Artifact tool will
refuse a plain publish and would otherwise create a *second* page. Do this:

1. `Artifact` with `action: "read"`, `url: https://claude.ai/artifact/R1FY8JSKruN8kvhu7XQ3B9`
2. `node build.mjs`
3. `Artifact` publish with `url` set to the same URL and `file_path` set to
   `06-scalping-copilot/index.html`. Omit `icon` (it keeps its existing one).

### Running things

```
node build.mjs            # inline src/*.js into index.html; refuses on name collisions
node test/run-all.mjs     # 410 assertions across 11 suites — unit level only
node desk/desk.mjs now    # the in-chat desk; see .claude/skills/scalp-desk/SKILL.md
node desk/desk.mjs scan --pair bitcoin   # one live read now (watch = poll each bar close)
node desk/replay.mjs --pair bitcoin --from 2026-01-01   # the watcher over history, with outcomes
node test/smoke.mjs       # real browser, 7 frozen moments x both views, fills in the brief; fails on page errors, overflow, "undefined"/"NaN"
```

`smoke.mjs` needs playwright, which is deliberately **not** a project dependency.
If it is missing: `(cd /tmp && npm i --no-save playwright@1.47.2)`. In the cloud
container it uses the preinstalled headless_shell under `/opt/pw-browsers`.

**Run the smoke test after any UI change.** The unit suites do not touch the DOM
and stayed fully green twice while the page was broken.

### Where we stopped (12 Oct 2026) — read this first

**Everything is committed and pushed** (last code commit `cb56ed9`); 410 unit assertions across
11 suites pass. The user cleared the context to **resume the tests**. On "resume", work this list
in order without asking again — the go-ahead is given:

1. **Tests for the watcher review's fixes.** The fixes are in code (`cb56ed9`) but have no tests
   of their own. Add them to `test/live.test.mjs` (fixture: `test/fixtures/btc-m15.json`, 10 days
   of recorded Binance M15 bars), at least one assertion each:
   - the final stretch is marked down **once**: a real read at fixture bar 586
     (2026-10-07T14:30:20Z) must pass `take` (`liveRead` passes `lastStretch: false`; the engine
     already applied ×0.6);
   - before ~06:00 London, `watch` waits for the open in real time instead of exiting (the skill
     had restarted it in a tight loop);
   - three failures of one feed drop only that instrument (`STATUS: dropped`); the other keeps
     watching;
   - `stillRunning`: no new alert on an instrument while the last one's stop or target is
     untouched and the window is open; the replay applies the same rule and clusters its range
     by day;
   - `relativeVolume` compares like with like (bitcoin weekday with weekday), from `htfBars`;
   - `minBars`: a 300-bar feed is skipped (it can never give the H4 bias);
   - `KEY_HOW`: the missing-key reply points at instructions that exist;
   - `take` chooses the instrument by price, not insertion order; `recordAlerts`: scan and
     watch no longer overwrite each other's alerts.
2. **SKILL.md** (`.claude/skills/scalp-desk/SKILL.md`) does not yet cover `STATUS: dropped`,
   `STATUS: need-key` or the `WATCHING:` line — add what the session does with each.
3. `node test/run-all.mjs`; then **the smoke test** (`node test/smoke.mjs` — the engine changed
   since it last ran green); then `node build.mjs` and **republish the page** (steps above; live
   page is still version 20; omit `capabilities` to keep `sample`).
4. Commit, push, and rewrite this section.

**Then, for the user:**
- **Gold key:** `TWELVEDATA_API_KEY` was **not set** in the container on 12 Oct (Twelve Data
  answers 401). Check `node -e "console.log(!!process.env.TWELVEDATA_API_KEY)"`; once true, run
  `node desk/desk.mjs scan --pair gold` to see whether the free plan serves 15-minute XAU/USD.
  Until then the watcher covers bitcoin only. The key goes in the cloud environment's variables
  (environment menu → Edit), never in `desk/config.json` (committed).
- **Start the watch only when they ask** ("watch"), weekdays 08:00–16:00 London. It cannot be
  pre-armed: outside the window `watch` exits `stopped`. The skill file says how to run it in the
  background and what to do with each way it ends. Phone pushes from a cloud session need Remote
  Control on their Mac; otherwise an alert is a chat message.
- The alerts are **demo practice, not evidence of an edge** (decision 26: the 1.5R rule averaged
  +0.03R a trade, −0.17 to +0.23, over 2026). Keep saying so, and keep advising a committed
  sample (~150) in "Is it working yet?" before reading anything into results.

**State of the build** (details in decisions 25–26):
- Timeframe is a setting, **M15 default**, M5 kept — built, reviewed, tested.
- **Price sites open** (12 Oct: Binance, Coinbase, Kraken 200; Twelve Data 401 without a key).
  Node needs `NODE_USE_ENV_PROXY=1`; the desk's network commands re-run themselves with it.
- **Watcher built**: `desk/live.mjs`, `desk.mjs scan | watch | take`, `desk/replay.mjs`,
  `src/timeframes.js`; target rule **1.5R when no level is in the way** (the user's choice);
  independent review done (17 findings, 13 confirmed ≈ 8 distinct, all fixed in `cb56ed9`).

### History of 11 Oct (for reference; superseded by the section above)

**Resumed 11 Oct (evening).** The price hosts were still refused (CONNECT 403 on all four), so
the user was given the network steps again (below). They then answered both open questions:
- **Timeframe: yes, M15 default, M5 kept** — built, see decision 25. 372 unit assertions and the smoke test (7/7, plus five timeframe checks) pass; an independent review was run after the first commit.
- **The watcher: wait until the price sites are open**, so nothing reaches them untested. Not
  started. **On resume:** run the curl check below; if it returns 200, the go-ahead is already
  given — build the watcher. It must follow the timeframe setting: the engine
  (`src/signal-engine.js`) is built on five-minute bars (its bar minimums, ATR stop multiple,
  the M15/H1 bias, `minStopPct`), so watching M15 means feeding it 15-minute bars and
  retuning those, not just changing the poll interval.

**Earlier the same day: live alerts, and a longer timeframe.** Asked how they could get
alerts rather than screenshotting, they were offered four routes (TradingView alerts ~$13–15
a month with a Pine script I'd write; an MT5 alert robot ~$15 a month plus a computer; Claude
watching in the chat; not yet). They chose **Claude watches in the chat**. Their setup: a Mac
they could leave on, but **MT5 only runs properly on their iPhone**, so MT5 stays there.

They then asked two things (both since settled — see above):
1. *Is it worth moving off M5 to give Claude and them more time?* — Answered **yes, M15**: the
   ~2-minute Thorough read plus screenshot/typing goes stale on M5, and wider M15 stops make the
   $6 BTC spread a smaller share of each trade with fewer trades paying it; fewer setups and
   smaller lots for the same risk are the trade-off, and it does not by itself create an edge.
   Offered to make the timeframe **a setting (M15 default, M5 kept)** and retune the checks
   (`checkPlan` rejects non-M5 today; prompts say M5; the 15-minute freshness window; stop
   floors and tolerances are M5-sized). **They said yes that evening — built (decision 25).**
2. *How to unblock the price sites, or can I do it?* — I cannot; the cloud environment's
   network policy is theirs. Steps given: session title bar → cloud environment menu → Edit →
   Network access → Limited → Allowed domains: `data-api.binance.vision`,
   `api.exchange.coinbase.com`, `api.kraken.com`, `api.twelvedata.com` (gold; needs their free
   key), with "Allow package managers" left ticked; docs
   https://code.claude.com/docs/en/cloud-environments#network-access. If it does not take
   effect in the running session, a new session with "resume" will pick it up.

**The check for the price hosts:**
(`curl -sS -m 10 -o /dev/null -w '%{http_code}' 'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=2'`
— 200 means unblocked). The M15 setting is done; what remains is the watcher —
live bars from those hosts into the existing engine (`src/signal-engine.js`, `src/data-feeds.js`)
and the desk's gate and checks, polling on the bar close, alerting the phone (check what
the session offers: PushNotification / Routines, and how long a cloud session can keep a
loop running before promising anything). Not yet built; nothing promised beyond that. The
user's answer on the watcher: build it once the sites are open, not before.

### Earlier on 11 Oct

- **The tool now runs inside the Claude chat** (decision 24). The user asked for it not to need
  a browser: they send MT5 screenshots into a Claude Code session from the Claude app. The
  session runs `desk/desk.mjs` by the rules in `.claude/skills/scalp-desk/SKILL.md`. This is
  now the main way the tool is used. The page below still works and is left published.
- Tested: 349 unit assertions (the desk's 42 included), and one full Thorough run with real
  reader agents on a stand-in MT5 chart image (they read the price and axis correctly, all
  called it "none", and the head trader and check agreed, in about 1½ minutes). An independent
  review (4 lenses, each finding put to a skeptic) confirmed 30 findings, about a dozen once
  de-duplicated, all fixed and under test. The one that mattered most was in `checkPlan()`,
  so the page had it too: a decision written "Buy" or "long" skipped every check and showed as
  a No trade with its direction in the summary. Now normalised, and anything unrecognised is
  rejected. The page was rebuilt for it, smoke-tested (7/7) and **published as live version 20**.
- **First real run, 5 Oct 2026 (~22:45 London, Monday, BTCUSD M5 screenshot):** worked end
  to end. The user sent the chart with no words; the gate asked for the price and spread;
  they answered with a screenshot of MT5's Quotes screen (bid 85,959.92 / ask 85,965.92, so
  spread 6.00) — taken as their answer, since it comes from the Quotes tab, not the chart.
  Because the Quotes screenshot arrived after the chart, the gate was run with `--image`
  pointing at the chart upload explicitly. Thorough: all three readers read the chart bid as
  85,944.40 and the axis correctly, all said "none"; head trader no_trade; `check` printed
  the No trade reply, sent as is. Run time about 2 minutes.
- **Next step:** nothing pending. On "resume", wait for the next screenshot or request and use
  the `scalp-desk` skill. If two pictures arrive (chart + quotes), pass the chart with
  `--image`.
- **11 Oct 2026:** the user asked for live-price alerts without screenshots. Researched and
  answered (see "Answers already given in chat", last entry); they were asked to pick a
  route — TradingView alerts, an MT5 alert robot, Claude watching in the chat, or proving
  the screenshot route first. **Nothing built yet; wait for their choice.**

### Before that (4 Oct 2026)

- The user reported the screenshot card **refuses pictures on their iPhone, even in
  Safari**: claude.ai's `sample.limits()` reports no `images` for that view (decision 23).
- Built, committed and tested (304 unit assertions, smoke 7/7 plus all failure-path and
  chat-route checks): the chat route (copy instructions → paste into a Claude chat with
  the screenshot → paste the reply back → same checks → ticket), a "try sending a picture
  anyway" button, the reason claude.ai gave, and **bitcoin analysed at any hour** (user
  request; decision 23).
- **Published 4 Oct 2026 as live version 19**, `sample` capability kept (capabilities
  omitted on the redeploy). The live page before it was exactly commit e1a84a7's build,
  so nothing saved from inside the page was lost.
- **Next step: wait for the user** to try the chat route on Bitcoin and report what the
  card says. Nothing is built or pending beyond that.

### What the page is (live page version 20, 4 Oct 2026; `capabilities: {sample: {}}` since version 18)

- **Inside claude.ai there are no live prices** (claude.ai blocks the feeds; the user
  chose to stay). Trade ideas come from **MT5 chart screenshots** read by Claude on the
  user's account (decision 22). Republishing must keep the `sample` capability: omit
  `capabilities` on a redeploy (that keeps it), never pass `{}`.
- **Opens in the simple view** (decision 18): the Read tab gives one answer word, the
  "wrong if" price, confidence, a ticket button, a session line and the next news;
  the Size tab gives the MT5 ticket and two inputs. "Show full detail" / Setup → View
  switches to everything.
- **Pre-session brief** before 08:00 (decision 19): overnight range, quiet/busy vs
  earlier nights, today's releases with flat times, sit-out and best hours, and a
  plan (setups + max trades) that will not save half-filled. In session: plan +
  tapped trade count. After: count vs plan.
- **How-to card** at the top of Setup (decisions 20–21), linked from the Read tab.
  Its times are computed. It was checked by three independent reviewers, which
  found real page bugs (all fixed) — worth repeating for any future user-facing
  instructions.
- All broker specs for both instruments are **confirmed** from the user's MT5.
- Account settings and the edge-test record persist on the phone; the stop
  distance and per-instrument overrides do not.

---

## The user

- UK-based. Scalps **XAUUSD and BTCUSD on the 15-minute chart** since 11 Oct 2026 (the
  5-minute chart before; it is kept as a setting).
- Trades **only the London session, 08:00–16:00 Europe/London**. Not at the screen outside it.
- Uses **MetaTrader 5 on an iPhone 17 Pro Max**. Mobile MT5 runs no custom
  indicators and saves no templates, so the tool cannot live inside it — the
  workflow is read chart in MT5 → compute here → type result back into MT5.
- Currently on an **IC Markets demo** — entity **Raw Trading Ltd** (the Seychelles
  entity, not FCA), server ICMarketsSC-Demo, **1:500 leverage, GBP account, hedge
  mode, ~£9.8m demo balance**. They said "no commission as I'm using demo", but the
  XAUUSD spec lists **£2.75 a lot per side** (in/out deals). The tool uses the spec;
  a closed trade's history would settle it.
- Asked for the tool to be **designed for the current demo balance**, and will
  re-scale when going live. Shadow-balance mode now lets both coexist.
- Prefers **direct answers to direct questions**. When asked for a figure, give
  the figure. They interrupted a research workflow launched for a simple
  calculation, and later a spread-consequences workflow, then said "continue" —
  do not reach for multi-agent research on arithmetic or small edits. When the
  session has ultracode on, a small verification workflow (3 reviewers) after
  building is welcome and paid off.
- Is **not technical**. Answer in plain English; they asked whether the tool was
  easy to use, which led to the simple view.
- Do **not** repeat back the email, phone number or MT5 login visible in the
  screenshots they sent, and never write them into this public repo.

### Confirmed XAUUSD symbol specification (read off their MT5, 20 Sep 2026)

| Field | Value | Meaning |
|---|---|---|
| Contract size | 100 XAU | $1.00 move = $100 per 1.00 lot |
| Digits | 2 | one point = $0.01 |
| Minimal volume | 0.01 | one ounce; $1 per $1 move |
| Stops level | 0 | no broker minimum stop distance |
| Margin currency | XAU | margin is in **ounces**, not dollars |
| Calculation | Forex | margin per lot = contractSize ÷ leverage oz |
| Initial margin | 100 | this is 100 **oz** (the contract size), not $100 |
| Chart mode | by bid | longs align with the chart; shorts' stops fire a spread early |
| Execution | Market | SL/TP often greyed until the position exists |
| Filling | Immediate or Cancel | partial fills likely at size; **demo never simulates them** |
| Spread | floating | observed **$0.05** in a quiet hour |

Added 24 Sep 2026 from the bottom of the same screen:

| Field | Value | Meaning |
|---|---|---|
| Maximal volume | 100 lots | per order; bigger positions are split |
| Commission | 2.75 GBP per lot, in/out deals | £5.50 round turn ≈ $7.40 |
| Swap | points; long −60.891, short +42.602 | −$60.89 / +$42.60 a lot a night |
| Triple swap | Wednesday | 7 charges a week |
| Sessions (server time) | 01:02–23:59, Friday to 23:57 | see server clock below |

**Server clock: UTC+3, confirmed** without a chart screenshot. Gold's daily break
ends 01:02 server; that break is 17:00–18:00 New York, so server = New York + 7 =
UTC+3 in September. Recheck during **25 Oct – 1 Nov 2026**: if the session times
shift in MT5 that week, the server follows Europe's clocks, not New York's.

### Confirmed BTCUSD symbol specification (24 Sep 2026)

| Field | Value |
|---|---|
| Contract size | 1 BTC — a $1 move is $1 per lot |
| Digits · min lot · step | 2 · 0.01 · 0.01 |
| Maximal volume | 10 lots per order |
| Stops level | 0 |
| Commission | none |
| Swap | percentage; long −20% a year, short 0, every night including weekends (≈ −$44 a lot a night at $80k) |
| Chart mode | by bid |
| Spread | **$6.00** at 10:26 London, 24 Sep (bid 84,399.55 / ask 84,405.55); the day's bid/ask highs and lows were also exactly $6.00 apart, so it looks fixed in ordinary hours |
| Margin (26 Sep) | type **notional value**, rate **0.002** initial and maintenance, buy and sell — 0.2% of value, ≈ $169 (£125) a lot at $84,400 |
| Sessions (server) | quotes 00:00–23:59, trade **00:05–23:59**; Friday to 23:55; Saturday from 00:45 |

Bitcoin's broker break is 21:59–22:05 London nightly and Friday 21:55–22:45 (BST),
nowhere near the window. The one thing still **unmeasured** on either instrument is
the spread at weekends and at the daily rollover.
Gold margin read £647 a lot, which corroborates 1:500.

---

## Decisions that look wrong and are not

A fresh session is likely to "fix" some of these. Don't, without reading why.

1. **No countdown to 16:00. No progress bar.** Salient end-of-period landmarks
   *causally increase* financial risk-taking, via optimism, on winning days as
   well as losing ones (Shah & Li 2025 JMR, ~5m decisions; McKenzie et al. 2016
   JBDM). An earlier version shipped both and they were removed. The session
   shows coarse words only — "Session open", "Into the final hour", "Final
   stretch". In the final 30 minutes the *engine* marks confidence down (×0.6) — it does not hide reads, and the page must not say it does
   instead of warning. Keep it unconditional on P&L.

2. **The dead zone withholds the read entirely.** 09:00–12:30 London for gold
   returns `stand-down` with no direction, not a weak one. A direction on screen
   gets traded, and range collapses there while spread does not. A news blackout
   outranks it.

3. **Gold's session is back-loaded, not front-loaded.** The liquidity handover
   that matters is the COMEX regular-hours ramp ~13:20 London, not the 08:00
   open. The 10:30 LBMA auction is ~a statistical non-event post the 2015 reform.

4. **News dates are table-driven, not rule-derived.** "NFP is the first Friday"
   is wrong 4 times in 12 for 2026 (Jan 9, May 8, Aug 7 are second Fridays; Jul 2
   is a Thursday because Jul 3 is the observed holiday). A test asserts the rule
   fails, so nobody "simplifies" it back.

5. **All times are wall-clock in a named IANA zone**, resolved at runtime. Never
   hardcode a UTC offset. US data is 13:30 London almost all year, 12:30 London
   in the two misalignment windows (2026: 8–29 Mar, 25 Oct–1 Nov).

6. **No dollar thresholds.** Gold went $5,602 → under $4,000 → ~$4,375 in 2026.
   Every floor is a fraction of price or an ATR multiple.

7. **Margin at 1:500 reads "not protecting you", not "comfortable".** At 1:20
   margin physically stops over-sizing; at 1:500 the platform would allow ~34×
   the intended position. A low margin figure there is the absence of a limit.

8. **The edge test refuses to give a verdict before a pre-declared sample.**
   Re-testing after every trade turns a 5% test into ~20% (reproduced over 6,000
   Monte Carlo runs of an edgeless system; 5.2% when tested once at fixed N).
   Uses **Wilson** intervals and **exact** streak probabilities (absorbing-Markov DP).

9. **At equal expectancy, a wider R:R needs MORE trades to prove, not fewer.**
   60%@1:1 and 40%@1:2 both give +0.20R; the 1:2 case needs ~2× the sample.

10. **DMI is shown but not scored.** Under close-only true range (+DI − −DI) is
    algebraically 2·RSI − 100. Scoring both double-counts across buckets.

11. **Point size on gold has no safe default.** $0.01, $0.10 and $1.00 are all
    in live use; IG, the largest UK provider, uses $1. Never claim one is "most
    common". Minimum stakes (£0.50 IG / £0.10 CMC) were refuted — not shipped.

12. **No 2:1 crypto leverage tier.** Crypto derivatives are *prohibited outright*
    for UK retail (COBS 22.6, since 6 Jan 2021). Offering 2:1 implied a BTCUSD
    CFD at an FCA firm is lawful — false, and it was removed.

13. **The tool never says which entity the user's account is on**, and never says
    they are breaking a rule (the prohibition binds firms). It gives the check to run.

14. **No tax claims at all.** Depends on circumstances and on HMRC's view of
    whether a trade is carried on. The spread-betting page is BIM22020, not BIM22015.

15. **Commission is counted, even on the demo.** On a $0.05-spread raw account,
    commission is ~58% of per-trade cost. Break-even uses the all-in figure. The
    Commission box takes GBP **per side** (as the spec prints it) and is empty by
    default, meaning "use the spec"; typing 0 means zero.

16. **The cost floor does not rank the two instruments.** It used to headline
    "bitcoin needs ~4× gold's move", from an indicative $30 BTC spread and a
    $0.35 gold spread with commission ignored. At the confirmed costs it is
    0.71 vs 0.28 bps (≈2.5×) per unit of *price* — but bitcoin moves further per
    bar, so that ratio is not cost per unit of opportunity. The card says so and
    points to the live spread-as-share-of-ATR reading. Do not reinstate a
    "bitcoin is dearer to scalp" headline without both instruments' ATR.

17. **Changing the leverage box does not change bitcoin's margin.** The BTCUSD
    spec prices margin as a fixed 0.002 of notional value, set per symbol; MT5
    does not divide a notional rate by account leverage. Gold is Forex mode, so
    its margin does follow leverage. `marginModel()` picks by the spec and the
    Size tab says which is in force. 0.2% equals 1:500, so the two agree on this
    demo — they need not on a live account, which is why the rate is re-read, not
    derived.

18. **The simple view is the default, and it says "Leaning up", not "Buy".**
    Built 26 Sep 2026 after the user asked whether the tool was easy to use (it
    was ~3,000 words over four tabs). One `simple` class on `<body>` hides
    everything marked `.detail` and shows `.simple-only`; nothing is recomputed,
    so the views cannot disagree. Its rules: no buy/sell instruction on the Read
    tab (it describes a lean and its invalidation; the ticket's BUY/SELL is only
    the MT5 side); the dead-zone stand-down shows **no**
    direction, not even the suppressed one the full view discloses; the session
    line uses the coarse phase words, never a time to the close; warnings are
    shortened, never dropped. The smoke test walks both views and fails on any
    visible "undefined" or "NaN".

19. **The brief asks; it does not tick.** Pre-market routines have no outcome
    evidence; checklists help only when they demand inputs (Haynes 2009 vs Urbach
    2014). So the plan will not save without a setup and a max-trades number, and
    there are no tick boxes. Gold's overnight runs from the 18:00 New York reopen
    (Sunday's on a Monday), bitcoin's is the last 24h; the busy/quiet verdict is
    like-for-like against up to 3 earlier nights by median, skips closed markets,
    and refuses with fewer than 2. The feed now fetches **1,000 bars** for this,
    but the engine is still handed the **last 300** — with more, relative volume
    would start voting, which should be a deliberate change, not a side effect.
    The plan and trade count live in localStorage (this phone, today only); the
    count is whatever the user taps, and nothing shows P&L.

20. **The how-to card's times are computed, not written.** `dayTimes()` derives
    every clock time on the Setup-tab card from the window and the session bands,
    measured from just before the open so it reads the same all day, and the card
    only re-renders when its text changes so an opened step stays open. Every
    label it names must be the label on the page — the smoke test opens all five
    steps and checks them.

21. **Green means current, real prices of the instrument itself — nothing else.**
    An independent review of the how-to card (26 Sep) found the card's one safety
    rule ("if the dot is not green, don't trade from the read") could be defeated:
    the PAXG proxy showed green (and its banner printed "undefined" — no
    `instrument` field), and manual mode stayed green forever. Now a proxy is
    always yellow, and typed bars go yellow 12 minutes after they were read in,
    like a feed. Also from that review: a typed Stop distance now moves the
    ticket's stop loss to match (Volume was sized from it while the stop stayed at
    the read's level); account-level settings and the "Is it working yet?" record
    persist (`in.*` keys) but per-instrument overrides and the stop distance
    deliberately do not; the final stretch is described as marking confidence
    down, because it never hides a read (bias ignores confidence — checked over
    300 random series); and the 13:20 COMEX boundary is `13 + 1/3`, not `13.3`
    (which rendered as 13:18).

22. **Trade ideas from screenshots — and the tool now says buy or sell.** Built
    27 Sep 2026 because claude.ai blocks every price feed and the user chose to
    stay in claude.ai. The page sends an MT5 screenshot to Claude through the
    artifact `sample` capability (declared on publish as `{sample: {}}`; viewer
    pays; consent can be asked each time the page is opened). Thorough = 3
    analysts (`complex`, one lens each, each reading keeps its lens label) + a
    head trader; Fast = 1 reader (`default`). **This reverses the "never says buy
    or sell" rule at the user's explicit request**; keep the ideas framed as
    ideas, keep "No trade" easy, keep the gates in code. An independent review
    (3 agents, 27 Sep) found real holes, all fixed and now under test:
    - **The typed price is required** (and the spread at weekends/outside the
      window). It is the only check that does not depend on reading pixels;
      the format examples in the prompts are shape-only "none"/"no_trade", so a
      reader that cannot see the axis has nothing plausible to copy.
    - **Market orders only**: the entry is the typed price; a limit idea is
      refused (it had been turned into a market ticket sized for the limit).
    - `checkPlan()` refuses: price on the chart ≠ typed price (tolerance
      max(3×cost, 0.3×stop)), wrong instrument or not M5, unread price scale,
      wrong-side stop, stop under max(10× all-in cost, ½×minStopPct×price),
      TP1 < 1:1 after spread+commission, low confidence, a limit order, a level
      off the visible axis ±25%, and on Thorough <2 readings agreeing. A
      rejected idea's direction, summary and reasons are not shown. The final
      stretch marks confidence down (decision 1).
    - `shotGate()`: closed when the broker's market is shut (`marketOpenNow`
      from sessionServer on the UTC+3 clock), stand-aside in a blackout,
      stand-down in the weekday dead zone (with the end time); caution for
      weekend BTC, outside the window, or a tier-1 release within 30 minutes.
      **The ticket applies the gate too**, and the gate is re-checked when an
      analysis finishes — an idea made just before NFP had kept its ticket.
    - The file input lives in the template, outside the re-rendered card (a
      re-render while the iOS picker was open dropped the pick), and the typed
      price and spread live in state.
    - Without live prices, practice bars never produce a lean, ticket levels or
      chart lines in either view. The ticket takes levels only from a fresh
      (<15 min), gate-open analysis on the same instrument; a typed stop is
      cleared by a new analysis or an instrument switch.
    The smoke test drives the flow against a stand-in `window.claude` and checks
    the failure paths (one analyst failing, permission refused, a limit idea,
    news starting after an analysis). The real capability cannot be exercised
    from the container; the first real run is the user's.

23. **Bitcoin screenshots at any hour; a chat route when pictures are refused.**
    4 Oct 2026, at the user's request: for BTCUSD the screenshot gate no longer
    stops in its quiet hours or outside the window, and a release blackout is
    a caution (spread required) rather than a block — they want to be able to
    trade whenever they choose. A closed broker market still stops it (MT5
    cannot take the order). **This is a deliberate partial reversal of decision
    2 for bitcoin's screenshot path only; gold keeps its blackout and dead
    zone.** Same day: on the user's iPhone the card said it could not send a
    picture — `sample.limits()` reported no `images` for that view, which is
    claude.ai's per-device decision (contract 0.2.67 is no different). The card
    now shows what claude.ai reported, offers one "try anyway" (a real call;
    `images_unavailable` then hides it for good), and a **chat route**:
    `chatPrompt()` copies the same context and rules for an ordinary Claude
    chat, the user attaches the screenshot there and pastes the reply back,
    `parseReply()` extracts the JSON and `checkPlan()` (asked: 0, like Fast)
    decides. Clipboard writes may be refused in the artifact frame, so the
    prompt is also shown to copy by hand.

24. **The tool runs in the chat, and the session is the reader, not the judge.**
    4 Oct 2026, at the user's request ("work within this session so it doesn't
    need to load on a browser"). `desk/lib.mjs` imports every rule from `src/`
    and adds only chat wording; `desk/desk.mjs` is the commands; the skill file
    is the protocol. Things that look like choices to undo, and are not:
    - **The gate runs before the picture is read**, and on a stop the session
      sends the gate's words and says nothing about the chart.
    - **The price comes from the user's words only**, never read off the picture
      to fill the gap: it is the one check independent of the picture.
    - **Thorough uses separate agents** that open the upload from disk
      (`~/.claude/uploads/<session>/`). They see only their prompt and the
      picture, not the conversation — so the user saying "looks like it's
      going up" cannot anchor them. Fast is the session's own read, told to
      ignore such remarks.
    - **A plain No trade shows its reasons but not its "against" list** — a
      deliberate difference from the page, where that list sits behind a Why?
      tap. Against a no-trade is the case for a trade; a chat has no tap.
    - **A typed spread is reused for one hour**, then asked for again where it is
      required (weekend or out-of-hours bitcoin, a bitcoin blackout).
    - **Plan, trade count and last spread are container state** (`~/.scalp-desk/`)
      and die with the container; the session restores the plan from the
      conversation. Account settings and the trade record are in
      `desk/config.json`, committed, so they survive.
    - **The ticket is sized with the spread the analysis used** (typed, or the
      confirmed usual one); the page sizes with 0 until a live spread is typed.
      Leaving it out undercounts the cost (decision 15), so the desk keeps it.
    - **No ticket on an idea over 15 minutes old, and none in a gate stop.** The
      levels and the warning stay; `size` leads with the gate's words.
    - **The server clock is `auto`: New York + 7**, from the gold-break evidence
      above — UTC+3 to 1 Nov, UTC+2 after. In 25 Oct – 1 Nov the desk asks the
      user what their MT5 clock reads; a number in `desk/config.json` overrides.
      The page still has its own fixed setting (Setup → MT5 server clock).
    - **Pictures sent together are not guessed at**: the gate stops with
      `need-image` and the session names each chart by path.

25. **The chart timeframe is a setting, M15 by default (11 Oct 2026, the user's choice).**
    One table, `TIMEFRAMES` in `src/shot.js`, drives everything that depends on the candle;
    the page (Setup → Chart timeframe, remembered on the phone) and the desk (`timeframe` in
    `desk/config.json`; `gate --tf` for one chart the user names) both read it. Things that
    look like oversights and are not:
    - **The stop floor's cost part does not scale; its noise part is ×√3 on M15** (a candle's
      range grows with the square root of its length). Gold's floor goes 1.24 → 1.90 at
      $4,391; bitcoin's 63.30 → 109.64 at $84,400.
    - **An M15 idea feeds the ticket for 30 minutes, not 45.** 45 would match M5's drift
      against the stop, but the structure the readers saw changes too.
    - **The final stretch stays the last 30 minutes on both.** It is decision 1's nudge about
      the session's end, not about how long a trade lasts. The news caution is what widens
      (60 minutes on M15), because there the open trade is the point.
    - **Price tolerance and the drift warning do not scale** — they are already fractions of
      the stop, which does.
    - **The reader prompts' JSON example says "e.g. H1"** for the timeframe: an example naming
      the expected one could be copied by a reader that cannot see the chart.
    - **The timeframe is never taken from the picture.** A chart on the other one is turned
      down with the switch offered (page: "set Chart timeframe…"; chat: "tell me to switch the
      desk…"). When the readers mark it unreadable for that reason, `head` names the timeframe
      they saw instead of "could not read it".
    - **Runs and analyses carry their own timeframe.** Freshness and checks use the one the
      analysis was made on, not a setting changed since; a desk run from before the setting
      has none and is treated as M5.
    - **The live engine is untouched** and still reads five-minute bars (blocked in claude.ai
      anyway). The Setup note says so in the full view.

26. **The live watcher (11 Oct 2026), and its 1.5R target rule.** `desk/live.mjs` runs live
    bars through the same engine, gate and `checkPlan()` as a screenshot; `desk.mjs watch`
    polls each bar close in the window and exits on an alert so the session wakes. Things
    that look like mistakes and are not:
    - **Alerts give distances, not prices.** No feed is IC Markets' quote (Binance,
      Coinbase and Kraken sat $100–135 apart on 11 Oct). `take` builds the ticket from the
      user's typed MT5 price; it refuses after one bar, after a feed drift of a quarter of
      the stop (same source only), and on a typed price more than 1.5% from the feed's.
    - **Silent wherever the spread is unknown** (weekend, outside the window, a bitcoin
      blackout) — the screenshot path asks for the spread there; the watcher cannot.
    - **Bitcoin's quiet hours do not withhold its read** (decision 23); gold's dead zone and
      blackouts stop it at the gate, as for a screenshot.
    - **The target rule is 1.5R when no level stands in the way.** The engine's own fallback
      target is exactly 1R, which can never pay 1R after costs, so with it every such idea
      was refused. `node desk/replay.mjs --pair bitcoin --from 2026-01-01` replays the
      watcher over history with outcomes (buy fills at ask; stops/targets on the right side;
      a bar touching both counts as the stop; still open at 16:00 London → closed there).
      Over 1 Jan – 11 Oct 2026 (6,464 checks in the window):
      | rule | alerts | a week | target / stop / 16:00 | average | 95% range |
      |---|---|---|---|---|---|
      | next level only | 50 | 1.2 | 16 / 29 / 5 | +0.04R | −0.35 to +0.43 |
      | 1.5R when clear | 120 | 3.0 | 24 / 41 / 55 | +0.03R | −0.17 to +0.23 |
      | 2R when clear | 117 | 2.9 | 18 / 41 / 58 | +0.04R | −0.17 to +0.25 |
      (Ranges clustered by day. These are after the watcher review's fixes: no new alert
      while the last one on the instrument is still running, and volume compared weekday
      with weekday over the full 1,000 bars. Halves of the stretch for 1.5R: −0.04R to
      21 May, +0.09R after. The user chose 1.5R on the FIRST run's figures — 175 alerts,
      +0.07R — which overlapping alerts had flattered; they were told the corrected result
      the same night: roughly break-even after the spread.) **No rule shows an edge.** The
      user was advised to treat the alerts as demo practice and to commit to a sample (~150)
      in "Is it working yet?" first. Do not describe the alerts as profitable.
    - **The engine reads M15 with its own table** (`src/timeframes.js`): "the last hour" is 4
      bars, the bias is H1 and H4 from a longer `htfBars` history (the window stays 300 bars),
      and its minimum stop is scaled by √3 so its stop always clears the desk's floor.
      Relative volume now votes on M15 (300 bars ≈ 3 days of slots); decision 19's "only the
      last 300" still holds for the page's M5 engine.

---

## Research digest

Every authoritative host (bls.gov, federalreserve.gov, fca.org.uk, gov.uk, all
broker and exchange sites) returned 403 from the build environment's egress
proxy. Findings rest on search extracts, some quoting primary text directly.
Nothing below was read on a primary page. Confidence is marked accordingly in code.

- **Prices (Sep 2026):** gold ~$4,375; bitcoin ~$78–81k. BTC/gold 30-day
  correlation ~0.72 (a nine-year high), BTC/Nasdaq ~0.22 — long both is roughly
  one doubled position.
- **Fed Chair is Kevin Warsh** (sworn in 22 May 2026). Never print "Powell".
- **CME crypto futures went 24/7 on 29 May 2026** — the "CME gap" no longer forms.
- **10y TIPS 2.653%** (highest since 2008) with gold near records — the
  real-yield inverse has broken; do not ship a "real yields up → gold down" signal.
- **FCA tiers** (COBS 22.5.11R): 3.33% major FX + certain sovereign debt; 5% gold,
  major indices, minor FX; 10% other commodities, minor indices; 20% shares and
  anything else. Apply to spread bets too. Close-out at net equity < 50% of
  *maintenance* margin, per *account*, "as soon as market conditions allow".
- **Elective professionals** do not necessarily lose FSCS/FOS access.
  FSCS for investment business is £85,000 (the £120,000 figure is deposits).
- **Bitcoin in the London window:** takes ~34–36% of daily variance (fair share),
  but its best hour is the user's last one and ~38% of the day's range falls in
  the seven hours after 16:00. Steer: gold before ~13:20, both after.
- **Cost floor (confirmed costs, 24 Sep):** 0.71 bps BTCUSD ($6.00 spread, no commission) vs
  0.28 bps XAUUSD ($0.05 + $0.074 commission per oz) — ≈2.5× per unit of price, not per
  unit of range. The earlier 3.7 vs 0.8 bps ("4× the move") used indicative spreads.
- **Sample sizes** (one-sided, α .05, power .80): vs a 50% null at 1:1 — 60% ≈ 153,
  55% ≈ 617, 52% ≈ 3,863 trades. Against the user's cost-adjusted 50.8% null the
  numbers are higher (55% ≈ 875).
- **Base rates:** ~1–3% of day traders earn predictably positive net returns;
  ~97% of Brazilians persisting past 300 days still lost (Barber/Lee/Liu/Odean;
  Chague/De-Losso/Giovannetti).
- **Journaling:** no direct evidence it improves trading outcomes; vendor-cited
  "studies" could not be found and are treated as fabricated. Adjacent evidence
  on self-monitoring is real but modest (Harkin et al. 2016, d ≈ 0.40).
- **Pre-market routines:** no credible evidence they improve outcomes. Checklists
  work only when they demand inputs (Haynes 2009) — tick-box versions show nothing
  (Urbach 2014).

The raw research JSON is in the session scratchpad and **will not survive** the
container being reclaimed. The digest above, the code comments, the README and
the commit messages are the durable record.

---

## Open items for the user

- Optionally, a BTCUSD bid/ask **at the weekend** and one **around 13:30 London on a
  US data day**, to see whether the $6.00 holds.
- Check one closed XAUUSD trade's commission in History, to settle the "no
  commission on demo" question.
- Recheck the XAUUSD session times in MT5 during **25 Oct – 1 Nov 2026** (server
  clock — see above).
- Optionally set a **shadow balance** and switch "Size from" to it (now remembered).
- Set a **committed sample size** in "Is it working yet?" before logging trades.
- Optional: tap **gbp / lot** on the BTCUSD margin row; it should read ≈ £125 at
  ~$84k (confirms the notional-rate reading of 0.002).
- Before going live: confirm whether the live account charges **commission**, which
  **entity** it sits on, and re-read both specs' **margin rows** (bitcoin's rate is
  set per symbol and may differ from the demo's 0.002).

## Not yet built — research-recommended, roughly in priority order

1. **Hide running P&L during the session**; show process counters instead
   (myopic loss aversion — frequent outcome evaluation worsens decisions).
2. ~~Pre-session brief~~ — **built 26 Sep 2026**, see decision 19.
3. **Releases that already happened** (e.g. UK ONS at 07:00) shown as settled-outcome
   cards, never as an overdue red badge.
4. **FOMC as a day-type label** ("the move is at 19:00, after your close") plus one
   flat-by-close prompt at 15:30 on those days.
5. **15:00 compound state** — ISM/UoM/Consumer Confidence print exactly as the
   final hour begins; treat as one hazard, not two flags.
6. **Per-trade log**, minimal: auto-capture facts, manual taps only for setup name
   and a pre-outcome rule-followed flag. Log in **R**, with an account-mode field so
   demo and live series stay separate.
7. **Gate the running stats behind a daily close-out review.**
8. **Cost as a share of gross R** ("costs consumed X% of your edge this month").
9. **Partial-fill recompute** — if filled volume < requested, recompute stop and R
   on the actual size and flag it.
10. Smaller: screenshot upload mode (`<input type="file" accept="image/*">`), live
    GBP/USD fetch, ForexFactory calendar cross-check, anchored VWAP.

## Known limitations

- **First iPhone run, 27 Sep 2026 (Sunday, iOS Safari, inside claude.ai):** the page
  renders correctly — layout, simple view, the three clocks, the weekend stand-down.
  But the BTC dot was **yellow**: every feed failed and it fell back to sample bars.
  Suspected cause: claude.ai's security policy for published pages forbidding
  connections to outside hosts (`connect-src`). The page now listens for the
  browser's `securitypolicyviolation` event and, if that is the cause, says so in
  the header, the Read banner and Setup → Data ("Blocked by claude.ai, not by the
  feeds"), listing the blocked hosts. Tested locally with a `connect-src 'none'`
  meta policy (and without one, to be sure it does not blame claude.ai for an
  ordinary network failure). **Confirmed by the user on reload, 27 Sep: claude.ai
  blocks it.**
- If claude.ai does block it, **live prices cannot work inside the artifact at all.**
  The options put to the user: host the same file on their own Netlify site (the
  Netlify connector is available; the page is static and needs no changes, but a
  Netlify URL is public to anyone who has it), or feed prices through a claude.ai
  connector via the artifact `mcp` capability (needs a market-data connector the
  user does not have; free tiers such as Alpha Vantage's 25 calls/day are too few
  for 5-minute polling). **The user chose to keep it in claude.ai, without live
  prices (27 Sep)** — do not re-offer Netlify unless they raise it. The tool is used
  as the how-to card's "If the dot is not green" step describes: the brief, news,
  plan, trade count and lot size from a typed stop; levels from the MT5 chart.
- Only headless Chromium runs here; no WebKit build is available in the container
  (do not run `playwright install`).
- A Home Screen icon on iOS may open as a web app with **storage separate from
  Safari's**, so saved settings/plan/key might not carry over. Unverified; the
  how-to card tells the user to use the icon from the start.

- **Live data endpoints were never verified from a real browser** — the sandbox
  blocked every market-data host. Binance (`data-api.binance.vision`) for BTC and
  Twelve Data (free key, in the query string) for gold are the documented intent.
  No custom headers are sent, deliberately: every CORS failure traced came from one.
- The MT5 iOS path to the Specification screen was never confirmed on-device.
- The root README of this portfolio was **left untouched**. Whether a trading tool
  belongs in an "n8n automation portfolio" table is the user's call; it was raised
  and not answered.

---

## Answers already given in chat, for continuity

- 0.20 lots XAUUSD long from the 2014 low (~$1,130) on £3,000, held to 2026 with no
  SL/TP: first answered **~£32,000** — $64,900 gross, less an *estimated* ~$25,000 of
  swap (the least certain input; range £25k–£51k). Revised once the real swap was
  read (24 Sep): −60.891 pts ≈ 5.1% of notional a year, not the 7% assumed, which
  puts it nearer **~£37,000**. Required sitting through a 37% drawdown
  to the Dec 2015 low (~$1,046).
- The same at **1.00 lot: £0** — 23.7× leverage, closed out ~$1,083 in 2015, a 4.1%
  adverse move. Couldn't even be opened at FCA 1:20. Survival threshold ≈ 0.56 lots.
- "Will it work on my iPhone?" — yes by design (built and tested at its screen size),
  but never run in Safari; everything except live prices is computed on the phone;
  whether claude.ai lets the page reach the price feeds is unknown — check the dot.
- "Is it just for my demo?" — set up with the demo's numbers but not locked to it;
  going live means re-reading both specs (commission, spread, margin rate, swap).
  If the live account is with a UK FCA firm, gold is capped at 1:20 and BTC CFDs are
  not offered to UK retail at all — find out which entity first.
- "How do I use it each day?" — the answer is now the how-to card on the Setup tab.
- "Is it worth using Jev with the tool?" (11 Oct) — **no, not as it works now.** Jev (TypeSafe
  AI, per one promotional article and social posts; no official page found) is a fast,
  cheap structured-decision model people wire to live price feeds and order APIs for fully
  automatic bots. Here the bottleneck is the human screenshot-and-type loop, not decision
  speed; there is no live feed inside claude.ai; nothing showed it reads chart images; MT5
  on an iPhone cannot execute a bot (it would need desktop MT5/a VPS or a broker bridge —
  a separate, riskier project outside the desk's checks); and faster deciding means more
  trades paying the $6 BTC spread. Advised proving an edge first with the pre-declared
  sample in "Is it working yet?", then revisiting automation as its own project.
- "Can it watch live prices and notify me buy/sell with SL/TP, so I don't miss a scalp —
  even using Claude desktop?" (11 Oct) — researched (5 strands, each re-checked by a
  skeptic; most vendor pages were unreachable from the container, so prices and plan
  limits rest on search extracts). Answer given: **possible, but not reliably from a Claude
  chat, and the signal it would push is unproven.** The user was asked to choose a route.
  - *This cloud session:* every market-data host is refused by the environment's network
    policy (Binance, Coinbase, Kraken, OKX, Bitstamp, Twelve Data, OANDA, gold-api, Yahoo:
    CONNECT 403). The user can allow domains (environment → Network access → Allowed
    domains); Node must then run with `NODE_USE_ENV_PROXY=1`. Even then: background jobs
    cap at 2 h, a Monitor at 30 min, the VM can pause when idle, Routines' floor is 1 hour,
    and phone push (PushNotification) is documented only via Remote Control. Not a
    dependable 8-hour alerter. Claude desktop: 1-minute scheduled tasks, but only while the
    app is open and the computer awake; phone push not guaranteed per event.
  - *TradingView* (recommended if they want alerts): carries IC Markets' own feed
    (`ICMARKETS:XAUUSD`, `ICMARKETS:BTCUSD`; match to the demo server unconfirmed); alerts
    run server-side and push to its iPhone app, typically seconds after bar close. Free
    Basic has **0 indicator alerts**; Essential (~$13–15/month USD, UK price unconfirmed)
    has 20, expiring after 2 months. Pine has no live news calendar — blackouts would be
    written in for the alert's 2-month life. Porting the engine needs custom code for
    relative volume, level clustering, structure, efficiency ratio, M15/H1 bias and gold's
    17:00 New York VWAP anchor. TradingView's official MCP (beta, 16 Sep 2026, Essential+)
    has **delayed** data, so it cannot be Claude's live feed; it can set simple price alerts.
  - *MT5 Expert Advisor + `SendNotification()`*: the broker's exact bid/ask, pushed into the
    MT5 app (max 2/s, 10/min; delivery "cannot be guaranteed", delays reported). Needs a
    terminal running all session: MQL5 Virtual Hosting ~$15/month (longer-term prices
    conflict), set up and updated only from desktop MT5 (Windows, or Mac via Wine).
    IC Markets' free VPS needs 15 live lots a month — not on demo. MQL5 cannot be compiled
    or tested in the container.
  - *Feeds, if built in the session:* Twelve Data free key for gold (800/day claimed,
    unconfirmed; free-key XAU/USD 5-min access to be tested; add `&timezone=UTC`), Coinbase
    candles for BTC (keyless; rows are [time, low, high, open, close, volume]). None is IC
    Markets' price, so levels must be distances re-anchored to the MT5 bid. MetaApi reads
    the user's own MT5 account but needs their login and is paid (calls `*.agiliumtrade.ai`).
  - *Code reuse:* `analyse()` already returns side, stop and targets from bars, and the
    gate, `checkPlan()` and sizing apply. A `watch` command is ~150–200 lines plus tests.
    Before building: drop the still-forming bar (`data-feeds.js` keeps it); pass
    `allowProxy: false` (the PAXG stand-in can otherwise print a gold ticket); pass the
    cost (no spread = no cost check); gate on `gateFor()` (outside 08:00–16:00 the engine
    still reads); settle bitcoin, where `sessionQuality()` stands down 08:00–12:00 and all
    weekend but decision 23 allows it at any hour; and set a shadow balance (sizing from
    £9.8m at 1% is meaningless).
  - *The catch:* the engine has never been tested against outcomes. On 2,000 random-walk
    series it still gave a direction ~70% of the time, and 0.3–1.4% of snapshots passed
    every check; its nearest target sat under 1R in 51% (gold) / 62% (BTC) of reads, which
    `checkPlan()` rejects. `desk/config.json` has 0 trades and no planned sample.

## Conventions

- Commit messages in the repo's existing style: a `type(06): summary` line, then
  prose explaining *why*. End with the attribution trailer the session's system
  reminder specifies.
- Never put a model identifier in the repo, the page, or code comments.
- Push with `git push -u origin claude/xauusd-btcusd-chart-analysis-8pvje5`.
- Don't open a PR unless asked.
