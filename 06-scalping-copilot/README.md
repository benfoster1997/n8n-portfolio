# M5 Scalp Desk — XAUUSD & BTCUSD

A single-file web dashboard that sits next to MetaTrader 5 on a phone and reads the
five-minute chart: trend and structure, where the levels are, what the session is
doing, what the spread is costing, and — the part that matters most — how long until
the next scheduled release that will blow through a tight stop.

**It is built around one fixed trading window**, the London session by default
(08:00–16:00 Europe/London). That assumption does real work: it decides which hours
are worth trading, which releases land while you are at the screen, which happen after
you have stopped, and which of the two instruments is worth watching right now.

**This is a personal tool, not a client deliverable and not a product.** It is built to
the same standard as the rest of this repository, and to the same principle: *say when
not to trust the output.*

It describes what the chart is doing and names the price at which that description is
wrong. The one exception, added at the user's request, is the screenshot card: it gives
buy or sell *ideas* from a picture of the MT5 chart, behind checks written in plain code
(see below).

---

## The problem it actually solves

Scalping a five-minute chart means the largest risk is not usually the analysis. It is
being in a position at 13:30 when a number lands.

A retail economic calendar will tell you Non-Farm Payrolls is "the first Friday of the
month." For 2026 that is wrong four times in twelve — 9 January, 8 May and 7 August are
second Fridays, and the July release is on Thursday the 2nd because Friday the 3rd is the
observed Independence Day holiday. A tool that derives the date from the rule will tell
you the coast is clear on the morning of the biggest print of the month.

So the calendar here is table-driven, every release time is stored as a wall-clock time
in a named IANA timezone and resolved at runtime, and every row carries a confidence
marker saying how well the date is actually established.

### The thing no other calendar shows you

Most retail MT5 servers run a GMT+2/+3 clock on the **European** daylight-saving
schedule. The US switches on a different date. For about four weeks a year the two are
out of step, and during those weeks US releases land **one hour earlier on your chart**
than they do the rest of the year.

In 2026 those windows are **8–29 March** and **25 October – 1 November**. The dashboard
shows a banner during them. Both windows shift news earlier, never later.

---

## What trading only the London session actually means

Two findings changed how the tool is built, and both contradict the usual advice.

**Gold's London session is not front-loaded.** The folklore says the 08:00 open is
prime. For gold it is not — gold is not an FX pair, and the liquidity handover that
matters is the COMEX regular-hours ramp at about **13:20 London**, followed by US data
at 13:30 and the New York equity open at 14:30. The stretch from roughly **09:00 to
12:30 London is a structural dead zone**: the range collapses while the spread does
not. The 10:30 LBMA auction will not rescue it — post the 2015 electronic-auction
reform it is close to a statistical non-event intraday.

So of an eight-hour window, **about three hours are genuinely worth scalping gold**.
The tool says so rather than colouring all eight hours in.

In the dead zone it **withholds the read entirely** rather than showing it weakly. A
direction on the screen gets traded, and a marginal setup that would be fine at 13:45
loses money at 10:30 purely on cost. It still discloses what it suppressed, so you can
see what is being set aside.

**Bitcoin is back-loaded, not unviable.** Your window catches roughly 34–36% of
bitcoin's daily variance — about its fair share of the clock. The sharper truth is
where that sits: bitcoin's single most volatile hour falls in your **last** hour, the
first four or five hours of your session are the worst bitcoin hours you could pick,
and roughly **38% of its daily range comes in the seven hours after you close** — more
than your whole session produces. If you ever wanted to extend the day, extending the
bitcoin end by ninety minutes is worth far more than starting earlier.

Hence the instrument steer: **gold before ~13:20 London, both after.** Because the LBMA
auctions are fixed in London time and bitcoin's peak tracks New York, that split holds
in both seasons.

### The clock facts that matter

US data lands at **13:30 London** almost all year, because the UK and US shift together.
During the two misalignment weeks it becomes **12:30 London** — an hour earlier. Both
windows shift it earlier, never later.

**The FOMC never reaches you.** 14:00 New York is 19:00 London, three hours after you
close; the press conference is 19:30. The news tab therefore splits into *while you are
trading* and *after you have stopped*, because those are different kinds of fact.

| Event | London time | Inside your window |
|---|---|---|
| NFP, CPI, PCE, retail sales, jobless claims | 13:30 | yes |
| ADP | 13:15 | yes |
| S&P flash PMIs | 14:45 | yes |
| ISM, UoM, Consumer Confidence | 15:00 | yes |
| LBMA PM auction | 15:00 | yes — but confounded with the US 10:00 ET slot |
| WM/Reuters fix | 15:57–16:02 | yes — a volatility burst, not a wind-down |
| **FOMC statement** | **19:00** | **no** |
| **FOMC press conference** | **19:30** | **no** |
| **FOMC minutes** | **19:00** | **no** |
| CFTC COT | 20:30 | no |

---

## Trade ideas from a chart screenshot

Inside claude.ai the page cannot load live prices — claude.ai's security policy blocks
its connections to every price feed (confirmed on the user's iPhone, 27 September 2026).
So the Read tab asks for the **current price, typed from MT5**, and a **screenshot of the
MT5 M5 chart**, and sends the picture to Claude on the user's own account through the
artifact `sample` capability. At weekends and outside the window it also asks for the
spread, which is unmeasured then.

- **Thorough** (default): three analysts read the picture independently — trend and
  structure, levels and liquidity, momentum and risk — then a head trader checks their
  work against the picture and decides. **Fast**: one reader, one pass.
- The answer is **Buy idea**, **Sell idea** or **No trade**. An idea is always a market
  order at the typed price, with a stop loss, take profit 1 (and a second level if the
  chart shows one), the reward-to-risk after spread and commission, the readers' own
  confidence, and how many readings agreed. The Size tab's ticket then carries the stop
  loss and take profit 1, with a lot size from the user's risk settings, for 15 minutes —
  and drops them at once if a blackout or the dead zone begins.
- **Plain code decides what the model cannot argue with.** No analysis at all — and no
  usage spent — when the broker's market is shut, in a news blackout, or in the weekday
  dead zone. Any plan becomes **No trade**, with the reason shown, if the chart shows a
  different price from the typed one, it is the wrong instrument or not M5, the price
  scale cannot be read, the stop is on the wrong side or inside the floor (the larger of
  10× the all-in cost and half the minimum stop), take profit 1 pays less than the risk
  after costs, the readers call it low confidence, it asks for a limit order, or a level is
  off the visible chart — and, on Thorough, if fewer than two readings agree. Fast has one
  reader, so it cannot catch a disagreement.
- The readers are one AI reading the picture four ways. They catch each other's slips,
  not a shared mistake; the typed price is the check that does not depend on the picture.

**This reverses a founding rule of the tool** — that it never says buy or sell — at the
user's explicit request. The ideas are framed as ideas from a picture, not signals.

**What it does not do.** It reads a picture: a level can be off by a little, so the page
says to check every level on the MT5 chart before entering. It has no track record and
has not been tested on past trades. It sees only what is in the screenshot — no order
book, no news content, nothing beyond the chart. Each analysis spends the user's own
Claude usage (four requests on Thorough, one on Fast). It works only when the page is
opened in claude.ai; any other copy of the page says so. The page never saves the
screenshot; it is sent to Claude on the user's account, like a chat attachment.

## The pre-session brief

Before 08:00 on a weekday, the Read tab opens with a brief:

- **The overnight range** — gold since its 23:00 reopen, bitcoin over the last 24 hours —
  and where price sits in it: near the high, near the low, or in the middle.
- **Whether the night was quiet or busy**, against the same stretch on up to three
  earlier nights (like for like: same length, same clock time, closed markets skipped,
  median rather than mean). With fewer than two usable nights it says so rather than guess.
- **Today's releases inside your window**, each with the time to be flat from and until.
- **The shape of the day**: the stretch to sit out and the stretch that is best.
- **Your plan**: which setups you will take, and the most trades you will take. It will
  not save until both are filled in.

During the session the brief shrinks to the plan and a trade count you tap ("+ I took a
trade"); after it, the count against the plan.

**Why it asks rather than shows.** There is no credible evidence that a pre-market routine
as such improves results. What does carry over from the checklist research is narrower:
checklists help when they demand an input and do nothing when they can be ticked through.
So the brief asks for two decisions and does not offer boxes to tick.

**What it does not do.** It cannot see your trades — the count is only what you tap. The
plan is stored in this phone's browser for today only; clearing Safari's data clears it. It
shows no profit or loss and no time to the close. Without live prices it asks you for the
overnight high, low and current price off your MT5 chart, and cannot compare with other
nights. With live prices, the range comes from the reference feed (Binance's BTCUSDT, or
Twelve Data for gold), which can sit a little away from your broker's levels.

## Two views: simple first

It opens in a **simple view**, because the full one runs to about 3,000 words across
four tabs, and that is too much to read between trades on a phone.

| | Simple view |
|---|---|
| **Read** | One answer — *Leaning up*, *Leaning down*, *No clear direction*, *Stand down* or *Stand aside* — the price that read is wrong at, confidence in a word, and a button to the ticket. Then one line for where you are in the day and one for the next news. The reasons sit behind **Why?**, in plain words rather than indicator names. |
| **News** | Only what can block a trade: context-only rows and the long explanations are hidden. |
| **Size** | The MT5 ticket, what it risks, and the two boxes that change every trade — stop distance and live spread. Warnings stay but shrink to a line: "Too big for one order. Place 1 × 100 lots and 1 × 63.11." |

**Show full detail** at the foot of each tab, or Setup → View, switches to everything
below. Both views run the same calculation; the simple one hides the working, not the
warnings. It does not relax any rule — the dead zone still withholds its read (and the
simple view does not even disclose what the technicals read underneath), a blackout still
overrides, and the Read tab still describes a lean rather than telling you to buy or sell
(the ticket's BUY or SELL is only which MT5 button a trade in that direction would use).

## What it shows (full detail)

| | |
|---|---|
| **Read** | Where you are in your session and what the rest of it looks like, then the directional lean, confidence, the invalidation price, targets with their R-multiple, and the win rate the setup needs just to break even after the spread. Plus a candle chart with session VWAP, clustered levels and the invalidation line. |
| **News** | Split into what lands *while you are trading* and what lands *after you have stopped*. Countdown, London time, and the time as it will appear on your broker's chart. Tier 1 rows produce a hard stand-aside state. |
| **Size** | Position sizing from account risk, with currency conversion and margin, the cost floor of each instrument in basis points, and the monthly cost of the spread at your trade frequency. |
| **Setup** | A step-by-step **how to use it each day** card (its times come from your window, not from prose), the view switch, data source, your broker's contract specs, server clock, your trading window, and the full list of what the tool cannot see. |

Every read carries a **case against it**. The engine always argues both sides, and when
nothing in the visible data opposes a read it says so — because that usually means it is
missing something rather than that the trade is safe.

---

## How the signal engine is built

**Correlated indicators share a bucket.** EMA slope, MACD, ADX and Supertrend are all
measuring roughly the same thing. A flat weighted sum over individual indicators lets one
observation vote four times and manufactures confidence that is not there. So indicators
average *within* a bucket, and only the bucket carries weight: trend, momentum, structure,
location, volatility, volume.

**Regime gates everything.** Trending, ranging, compressed or mixed is decided first, from
ADX plus a Kaufman efficiency ratio plus where Bollinger width sits in its own recent
distribution. In a range, trend weight drops to 4% and the engine *says out loud* that it
is discarding trend signals rather than quietly down-weighting them.

**A bucket with no data abstains.** Its weight is removed from the calculation rather than
redistributed onto the others, and the lost information is charged to confidence. A
missing input must never silently inflate the remaining ones.

**Volatility never votes on direction.** It describes whether conditions suit a scalp at
all, and modulates confidence. It has no opinion on which way to go.

**Nothing is emitted without an invalidation price.** The engine prefers a structural level
— the swing the read would be wrong beneath — and falls back to an ATR stop, saying which
it used. If it can produce neither, it returns `no-read` rather than a signal.

**A tier-1 news blackout is a hard override, not a factor.** Inside the window the engine
returns stand-aside regardless of how good the technicals look, and discloses what it
suppressed so you know what you are setting aside.

**The dead zone suppresses rather than down-weights.** In the structurally quiet hours
the engine returns stand-down and withholds the direction, because a weak read on
screen is a read that gets taken. A news blackout outranks it — that is the more urgent
reason to be flat.

---

## Running it

```
node build.mjs        # inline src/*.js into a single self-contained index.html
node test/run-all.mjs # 214 assertions across 7 suites
node test/smoke.mjs   # real browser; needs playwright, see the file header
```

`index.html` has no build dependency, no backend and no imports. Open it from anywhere,
including offline — the news calendar, the session clock and the risk arithmetic are all
pure client-side computation and need no network at all.

On the iPhone: open it in Safari, then **Share → Add to Home Screen**. It runs full-screen
with the safe areas handled.

---

## What this does not do

- **It cannot see order flow, the order book, or real traded volume.** On an MT5 gold feed
  the "volume" is a tick count — the number of price updates, not contracts traded. Every
  volume-derived reading is a proxy for activity, not a measure of participation.
- **It reads a reference price, not your broker's.** Exchange spot, tokenised gold and a
  broker's CFD all differ in level and in spread, and they diverge most at exactly the
  moments the tool finds interesting. Entries, stops and targets come from MT5. This is
  context and a news clock, not an execution price source.
- **Nothing in it is backtested and it has no track record.** The weights are reasoned,
  not fitted. That makes them honest rather than optimal.
- **It knows *when* releases are scheduled, not what they say.** It cannot read the number
  and has no idea an unscheduled headline just landed.
- **It does not watch the dollar, real yields or the Nasdaq.** Gold can be technically
  perfect and get run over by a move in DXY. It also does **not** ship a "real yields up →
  gold down" signal, because that relationship inverted during 2026 — 10-year TIPS at
  2.653%, the highest since 2008, with gold near record highs.
- **Release dates were gathered from search results, not read off the issuing agency.**
  The environment this was built in blocked outbound access to bls.gov, bea.gov and
  federalreserve.gov. Anything marked *unconfirmed* in the UI needs checking against your
  broker's calendar before you rely on it.
- **The live price endpoints were never verified from a browser.** The same egress policy
  blocked every market-data host, so the CORS behaviour is documented intent, not observed
  fact. The design assumes failure: sources are tried in order, the UI always names which
  one answered, and manual entry needs no network.
- **Its buy and sell ideas have no track record.** They come only from a screenshot the
  user sends, are read from a picture, can be a little off, and must be checked against
  MT5 before entering.

## Knowing whether it works

The panel that answers "am I any good at this", and the reason it refuses to
answer quickly.

**The null is not 50%.** Break-even is whatever costs make it — 50.8% at 1:1 on a
$0.05 spread with a $3 stop, and 60% if the stop tightens to $1.50 with commission.
Testing against 50% systematically declares losing systems profitable.

**Sample size scales with the inverse square of the edge.** 60% separates from
break-even in ~150 trades. 55% needs ~620. 52% — still profitable — needs ~3,900,
about three years at five trades a day.

**An observed 60% over 30 trades means nothing.** The Wilson interval runs 42–75%,
which includes the coin flip and reaches down into steadily-losing territory.

**The sample must be committed to before collecting it.** This is the part most
dashboards get wrong, including this one until it was measured. A tool that re-runs
the test after every trade and announces a result whenever one appears is not running
a 5% test: simulated over 6,000 runs of a genuinely edgeless system, continuous
re-testing declares an edge **20.4% of the time within 500 trades**. Applied once at a
pre-declared N, the same test comes back at 5.2%. So no verdict is offered until the
declared sample is reached — before that it reports the interval, which is descriptive
and honest, and how far there is to go.

**The verdict is three-valued.** Evidence of an edge, evidence against one, and not
enough trades to say. Conflating the third with the second is how working systems get
abandoned.

**It tells you the losing run to expect.** At 55% over 500 trades, a seven-loss run has
a 64% chance of occurring — computed exactly by absorbing-Markov DP, not the
overlapping-windows approximation. That run is what the arithmetic predicts, not
evidence the approach has stopped working.

**A sample is necessary and nowhere near sufficient.** Across the two large studies of
the question, on the order of 1–3% of day traders earn predictably positive net
returns, and among those who persisted past 300 trading days roughly 97% still lost
money. Persistence is not the variable that separates them.

## Shadow balance

The demo is funded at a size that will never be traded. Sizing from it builds habits
calibrated to the wrong number — position size, the shape of the P&L, and what a losing
run feels like.

So the tool can size from a **declared live balance** instead, leaving the demo account
untouched. Same chart, same specs, same session; every figure shown is at the scale that
will actually be traded. At £9.8m a 1% risk on a $3 stop is 434 lots; at a £5,000 shadow
balance it is 0.22.

Demo results also carry an asymmetric haircut, because demo fills have no slippage and —
for this symbol specifically — MT5 demo does not simulate partial fills at all, so
Immediate-or-Cancel behaviour is the one thing it cannot show. Stops are market orders
triggered into adverse movement and slip; targets are limits that only fill on touch and
do not. A symmetric correction would understate the damage.

## No countdown, by design

The session shows coarse phase words — "Session open", "Into the final hour", "Final
stretch" — and deliberately no timer, no progress bar and no colour ramp toward the close.

Salient end-of-period temporal landmarks causally increase financial risk-taking, through
optimism rather than loss-chasing, which means the effect is reference-independent and
fires on winning days as much as losing ones (Shah & Li 2025, *Journal of Marketing
Research*, across ~5m real investment decisions; McKenzie et al. 2016, *JBDM*). An earlier
version of this tool shipped both a progress bar and a "15 minutes left" counter, which
made it a participant in the behaviour it exists to guard against.

In the final half hour the engine raises its own bar instead — the confidence multiplier
drops to 0.6 and the case against names the reason. A behaviour change is something you
do not have to resist. It is also unconditional on P&L, because the ending effect is.

## Margin is the constraint, not risk

The thing a risk-percentage calculator cannot see.

Margin as a share of equity is **`m × r ÷ s`** — the margin factor, times your risk
percentage, divided by the stop expressed as a *fraction of price*. Account size cancels
out: a £5k and a £100k account face the same percentage.

The price level does **not** cancel, and this is the part worth being precise about.
Substituting `s = D/P` gives **`M/E = m × r × P ÷ D`**, which scales *linearly* with
price for a fixed dollar stop. It is price-invariant only if you hold the stop as a
constant fraction of price — which is not how anyone actually thinks about a stop.

Under the FCA's 20:1 cap on gold (5% margin), at 1% risk:

| Stop | As % of price | Margin needed |
|---|---|---|
| $2.20 | 0.05% | **100% of the account** |
| $3.00 | 0.068% | **73%** |
| $4.39 | 0.10% | 50% |
| $8.78 | 0.20% | 25% |
| $14.93 | 0.34% | 15% |

A perfectly sensible 1%-risk trade with a scalp-width stop can therefore consume
three quarters of the account in margin, leave you unable to hold anything else, and
sit near the level where a small adverse move starts forcing closures.

So the same $3.00 stop costs **33% of the account at $2,000 gold, 73% at $4,391 and 83%
at $5,000**. Every dollar-denominated rule of thumb inherited from cheaper gold
understates this, and it understates it in the dangerous direction.

The tool shows this as a gate with the arithmetic, not a footnote.

## It outputs an order ticket, not a recommendation

MT5 on iPhone runs no custom indicators and saves no chart templates, so the tool cannot
live inside it. The real workflow is: read the chart in MT5, compute here, type the
result back into MT5. That app-switch is the constraint the output has to survive — few
numbers, large, and in exactly the form the ticket expects.

So the Size tab leads with three numbers:

- **Volume**, in lots — because the MT5 ticket takes lots whether the account is a
  spread bet or a CFD.
- **Stop loss** and **take profit**, as **absolute price levels** — because that is what
  the mobile ticket expects. Handing over a distance would mean converting it in your
  head on the other side of an app switch, which is where mistakes happen.

It also checks the stop against your broker's **stops level** before you get there, so
the ticket does not bounce with an "invalid stops" error at the moment of entry.

The spread-bet stake per point is still computed, but demoted to a cross-check, since it
is not what you type. It reconciles with the lot figure to the penny before rounding —
there is a test asserting it. Everything rounds **down**: rounding £3.333 up to £3.50
turns 1% risk into 1.05% silently, on every trade.

**Point size on gold is firm-specific** — $0.01, $0.10 and $1.00 are all in live use at
UK firms, including the largest ones. There is no safe default, so the tool does not
claim one, and shows all three at once.

## One more thing it is loud about

**What a round trip costs before the chart is consulted.** At the costs read off the
user's MT5 — gold's $0.05 spread plus £5.50 a lot of commission, bitcoin's $6.00 spread
and no commission — one round trip costs about **0.28 bps on XAUUSD and 0.71 bps on
BTCUSD**. Per unit of price, bitcoin is about 2.5× dearer. The tool says plainly that this
is not the same as 2.5× harder to scalp: bitcoin usually moves further in a 5-minute bar,
and the fair comparison is each instrument's spread against its own ATR, which the Read
tab computes live.

This section used to say bitcoin needed four times gold's move. That came from an
indicative $30 bitcoin spread and a $0.35 gold spread with commission left out. Both were
wrong for this account, and leaving commission out flattered gold by about 2.5×.

## Two more things it is loud about

**Gold and bitcoin are currently close to the same trade.** Their correlation reached a
nine-year high during 2026 — around 0.72 on a 30-day basis, against roughly 0.22 for
bitcoin and the Nasdaq. Long both, or short both, especially in the hour after a US macro
print, is one position at double size rather than two diversified ones. The dashboard says
so on the sizing screen, because the tool itself could otherwise encourage that mistake.

**The spread is the dominant cost of scalping and it is paid whether you are right or
wrong.** The tool shows live spread as a share of current ATR — above roughly 40% the cost
structure is simply broken — and shows the monthly total at your trade frequency. The
break-even win rate it displays is the honest version of the arithmetic: at 1:1 with a
spread worth a fifth of the stop, you need about 60%, not 50%.

---

## The gold specification, confirmed

Read off the symbol specification on 20 September 2026 and no longer a default:

| | |
|---|---|
| Contract size | 100 XAU per lot — a $1.00 move is $100 |
| Digits | 2, so one point is $0.01 |
| Minimum volume | 0.01 lots — one ounce, $1 per $1 move |
| Stops level | 0 — no broker minimum stop distance |
| Chart mode | by **bid** price |
| Margin currency | XAU, calculation Forex |
| Spread | floating; observed $0.05 |

**Margin is leverage-derived, not a fixed percentage.** The specification's
"Initial margin: 100" looks impossible until you notice the margin currency is XAU —
it is 100 *ounces*, the contract size, not 100 dollars. Under MT5's Forex calculation
mode margin per lot is `contractSize ÷ leverage` ounces, converted at the live gold
price. At 1:20 that is 5 oz, $21,875 a lot at $4,375 gold, which is exactly 5% of the
$437,500 notional. So the tool asks for account leverage rather than a percentage.

**The chart is drawn from bid prices**, which is not symmetric between directions. A
long fills at the ask but has its stop and target checked against the bid, so both line
up with the candles. A short fills at the bid but has its levels checked against the
**ask** — so its stop fires while the chart is still a spread short of the drawn level,
and its target needs the chart to travel a spread past it. That is just the spread being
paid, but on a short it is paid somewhere the chart does not show it, which is why a stop
can look like it was hit before price got there. The ticket says so, per direction.

## Contract specs are asked for, never assumed

Contract size, tick value and minimum lot are set by your broker, not by the market, and
they vary between brokers and between account types at the same broker. A standard lot of
bitcoin is 1 BTC at some brokers and a fraction of that at others — getting it wrong
scales every position by a factor of 100.

Everything broker-dependent is shown as an unconfirmed default until you check it. On the
iPhone: **Quotes → press and hold the symbol → Specification**.

Read off the user's IC Markets demo so far:

| | XAUUSD | BTCUSD |
|---|---|---|
| Contract size | 100 oz | 1 BTC |
| Digits · min lot · step | 2 · 0.01 · 0.01 | 2 · 0.01 · 0.01 |
| Max volume per order | 100 lots | 10 lots |
| Stops level | 0 | 0 |
| Commission | £2.75 a lot **each side** (£5.50 round turn) | none |
| Swap | −60.891 pts long / +42.602 short, triple on Wednesday | −20% a year long, 0 short, charged every night including weekends |
| Spread | $0.05, floating (quiet hour) | $6.00 — and $6.00 at the day's high and low, so it looks fixed in ordinary hours |
| Margin | contract ÷ account leverage (Forex mode): £647 a lot at 1:500 | **0.2% of value, set by the symbol** — the leverage setting does not change it (≈ £125 a lot at $84k) |
| Broker's own break, London time (BST) | 21:59–23:02 nightly | 21:59–22:05 nightly; Friday 21:55–22:45 |

The swap is not in the scalping arithmetic — a flat-by-16:00 scalper never pays it — but
the Size tab states it in money so a position left open is priced honestly. Still
unchecked: either spread at weekends or at the daily rollover. Neither broker break comes
near the 08:00–16:00 window, in summer or winter, and a test holds that.

---

## Layout

```
src/
  timezone.js       DST-safe conversion; fuzzed over 3 years, both zones, hourly
  indicators.js     dependency-free TA, seeded to match MT5/TradingView
  instruments.js    contract specs, commission and swap; unread ones marked confirm-before-use
  risk.js           sizing under both UK account models, the margin gate,
                    break-even win rate, spread drag
  news-calendar.js  table-driven event data + blackout logic
  sessions.js       the trading window, per-instrument hour bands, instrument steer
  data-feeds.js     ordered source chain with honest failure reporting
  signal-engine.js  regime detection, factor buckets, the read
  edge-test.js      whether a run of results means anything yet
  brief.js          the pre-session brief: overnight range, the day, the plan
  shot.js           screenshot analysis: prompts, the gate, and the checks on every plan
  app.js            UI wiring
  index.template.html
build.mjs           inlines the above into index.html
test/               214 assertions; run-all.mjs runs the lot
                    smoke.mjs loads the page in a real browser at six
                    frozen session moments and fails on any page error
HANDOFF.md          state, decisions and research, for picking this up cold
```
