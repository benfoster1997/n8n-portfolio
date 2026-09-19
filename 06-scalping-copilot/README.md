# M5 Scalp Desk — XAUUSD & BTCUSD

A single-file web dashboard that sits next to MetaTrader 5 on a phone and reads the
five-minute chart: trend and structure, where the levels are, what the session is
doing, what the spread is costing, and — the part that matters most — how long until
the next scheduled release that will blow through a tight stop.

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

## What it shows

| | |
|---|---|
| **Read** | Directional lean, confidence, the invalidation price, targets with their R-multiple, and the win rate the setup needs just to break even after the spread. Plus a candle chart with session VWAP, clustered levels and the invalidation line. |
| **News** | Every scheduled release for the selected instrument over the next seven days, with a countdown, the UTC time, and the time as it will appear on *your* broker's chart. Tier 1 rows produce a hard stand-aside state. |
| **Size** | Position sizing from account risk, with currency conversion, and the monthly cost of the spread at your trade frequency. |
| **Setup** | Data source, your broker's contract specs, server clock, and the full list of what the tool cannot see. |

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

---

## Running it

```
node build.mjs        # inline src/*.js into a single self-contained index.html
node test/run-all.mjs # 102 assertions across 4 suites
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

## Two things it is loud about

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
  risk.js           position sizing, break-even win rate, spread drag
  news-calendar.js  table-driven event data + blackout logic
  sessions.js       session boundaries and per-instrument quality bands
  data-feeds.js     ordered source chain with honest failure reporting
  signal-engine.js  regime detection, factor buckets, the read
  app.js            UI wiring
  index.template.html
build.mjs           inlines the above into index.html
test/               102 assertions; run-all.mjs runs the lot
```
