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

It never tells you to buy or sell. It describes what the chart is doing and names the
price at which that description is wrong.

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

## What it shows

| | |
|---|---|
| **Read** | Where you are in your session and what the rest of it looks like, then the directional lean, confidence, the invalidation price, targets with their R-multiple, and the win rate the setup needs just to break even after the spread. Plus a candle chart with session VWAP, clustered levels and the invalidation line. |
| **News** | Split into what lands *while you are trading* and what lands *after you have stopped*. Countdown, London time, and the time as it will appear on your broker's chart. Tier 1 rows produce a hard stand-aside state. |
| **Size** | Position sizing from account risk, with currency conversion and margin, the cost floor of each instrument in basis points, and the monthly cost of the spread at your trade frequency. |
| **Setup** | Data source, your broker's contract specs, server clock, your trading window, and the full list of what the tool cannot see. |

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
- **It will never tell you to buy or sell.**

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

**Bitcoin's cost floor is several times gold's.** At a $30 bitcoin spread and a $0.35
gold spread, one round trip costs about **3.7 bps on BTCUSD against 0.8 bps on XAUUSD**
— bitcoin needs roughly four times the move just to get back to flat, at every hour of
your day. That constant does not vary with the session, and it is probably the single
most useful number in the tool.

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

---

## Layout

```
src/
  timezone.js       DST-safe conversion; fuzzed over 3 years, both zones, hourly
  indicators.js     dependency-free TA, seeded to match MT5/TradingView
  instruments.js    contract specs, all marked confirm-before-use
  risk.js           sizing under both UK account models, the margin gate,
                    break-even win rate, spread drag
  news-calendar.js  table-driven event data + blackout logic
  sessions.js       the trading window, per-instrument hour bands, instrument steer
  data-feeds.js     ordered source chain with honest failure reporting
  signal-engine.js  regime detection, factor buckets, the read
  edge-test.js      whether a run of results means anything yet
  app.js            UI wiring
  index.template.html
build.mjs           inlines the above into index.html
test/               214 assertions; run-all.mjs runs the lot
                    smoke.mjs loads the page in a real browser at six
                    frozen session moments and fails on any page error
HANDOFF.md          state, decisions and research, for picking this up cold
```
