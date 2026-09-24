# Handoff — M5 Scalp Desk

Everything needed to pick this up in a fresh session without re-deriving it.
Last updated 24 September 2026. Read this whole file before changing anything —
several decisions below look like mistakes and are not.

---

## Where things are

| | |
|---|---|
| Code | `06-scalping-copilot/` in this repo |
| Branch | `claude/xauusd-btcusd-chart-analysis-8pvje5` — pushed, **no PR opened** (never asked for one) |
| Live page | https://claude.ai/artifact/R1FY8JSKruN8kvhu7XQ3B9 (private to the user) |
| Shipped file | `06-scalping-copilot/index.html`, **generated** by `node build.mjs` from `src/` — never edit it directly |

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
node test/run-all.mjs     # 214 assertions across 7 suites — unit level only
node test/smoke.mjs       # real browser, 6 frozen London-session moments, fails on any page error
```

`smoke.mjs` needs playwright, which is deliberately **not** a project dependency.
If it is missing: `(cd /tmp && npm i --no-save playwright@1.47.2)`. In the cloud
container it uses the preinstalled headless_shell under `/opt/pw-browsers`.

**Run the smoke test after any UI change.** The unit suites do not touch the DOM
and stayed fully green twice while the page was broken.

---

## The user

- UK-based. Scalps **XAUUSD and BTCUSD on the 5-minute chart**.
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
  calculation — do not reach for multi-agent research on arithmetic.
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

Still **unread**: BTCUSD's bid/ask (typical spread — the tool still shows it as
unconfirmed) and its margin rows (the screenshot cut off below "notional value").
Gold margin read £647 a lot, which corroborates 1:500.

---

## Decisions that look wrong and are not

A fresh session is likely to "fix" some of these. Don't, without reading why.

1. **No countdown to 16:00. No progress bar.** Salient end-of-period landmarks
   *causally increase* financial risk-taking, via optimism, on winning days as
   well as losing ones (Shah & Li 2025 JMR, ~5m decisions; McKenzie et al. 2016
   JBDM). An earlier version shipped both and they were removed. The session
   shows coarse words only — "Session open", "Into the final hour", "Final
   stretch". In the final 30 minutes the *engine* raises its bar (confidence ×0.6)
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
- **Cost floor:** ~3.7 bps BTCUSD vs ~0.8 bps XAUUSD — bitcoin needs ~4× the move.
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

- Send the **BTCUSD bid/ask** (Quotes screen, advanced view) so its spread can be
  marked confirmed, and the **bottom of the BTCUSD spec** for its margin rows.
- Check one closed XAUUSD trade's commission in History, to settle the "no
  commission on demo" question.
- Recheck the XAUUSD session times in MT5 during **25 Oct – 1 Nov 2026** (server
  clock — see above).
- Optionally set a **shadow balance** and switch "Size from" to it.
- Set a **committed sample size** in "Is it working yet?" before logging trades.
- Before going live: confirm whether the live account charges **commission**, and
  which **entity** it sits on.

## Not yet built — research-recommended, roughly in priority order

1. **Hide running P&L during the session**; show process counters instead
   (myopic loss aversion — frequent outcome evaluation worsens decisions).
2. **Pre-session brief, 07:30–08:00**, demanding inputs not ticks: overnight range
   and where price sits in it (Asia for gold, 24h for BTC), overnight volatility vs
   norm, today's in-window prints, the day's intent (live setups, max trades).
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

## Conventions

- Commit messages in the repo's existing style: a `type(06): summary` line, then
  prose explaining *why*. End with the attribution trailer the session's system
  reminder specifies.
- Never put a model identifier in the repo, the page, or code comments.
- Push with `git push -u origin claude/xauusd-btcusd-chart-analysis-8pvje5`.
- Don't open a PR unless asked.
