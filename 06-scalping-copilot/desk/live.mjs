/**
 * desk/live.mjs — the watcher: live bars through the same engine, gate and
 * checks as everything else, and a chat reply when an idea passes them all.
 *
 * Why this exists. The user asked to be alerted instead of screenshotting
 * (11 Oct 2026), chose "Claude watches in the chat", and allowed the price
 * hosts in the cloud environment. So at each bar close the desk fetches the
 * live chart, reads it with src/signal-engine.js on the desk's timeframe
 * (M15 unless switched), and runs the result through the same checkPlan()
 * a screenshot idea goes through. Only an idea that passes is sent.
 *
 * What it is not, said plainly in every alert:
 *  - NOT THE BROKER'S PRICE. Bitcoin comes from Binance (BTCUSDT) or Coinbase /
 *    Kraken (BTC-USD), gold from Twelve Data (XAU/USD). They sit tens of
 *    dollars from IC Markets' quote. So an alert gives the stop and target as
 *    DISTANCES, and the ticket is built from the price the user then types
 *    from MT5 (`take`), never from the feed's level.
 *  - NOT TESTED AGAINST OUTCOMES. The engine has no track record. On random
 *    walks it still leaned a direction about 70% of the time; the checks are
 *    what keep that from becoming a stream of alerts.
 *  - NOT THE LIVE SPREAD. The cost is the confirmed usual spread. Wherever the
 *    screenshot gate would ask for the spread (weekend, outside the window, a
 *    bitcoin release blackout), the watcher stays quiet instead of guessing.
 *
 * Pure apart from nothing: bars are handed in, so it is tested without a network.
 */
import { INSTRUMENTS } from '../src/instruments.js';
import { analyse, MIN_BARS } from '../src/signal-engine.js';
import { closedBars } from '../src/data-feeds.js';
import { checkPlan } from '../src/shot.js';
import { tfInfo } from '../src/timeframes.js';
import { sessionQuality, windowState } from '../src/sessions.js';
import { getActiveBlackout } from '../src/news-calendar.js';
import { formatHM } from '../src/timezone.js';
import {
  gateFor, costFor, label, digitsOf, fmt, sizeFor, sizeWarnings, riskLine, ticketLines,
  nextNewsLine, planLine, cautionAfter, forChat, timeframeFor, gateWord,
} from './lib.mjs';

/** Bars the engine reads (as on the page), and bars fetched (for the higher-timeframe bias). */
export const ENGINE_BARS = 300;
export const FETCH_BARS = 1000;

/**
 * Bars a feed must give for the read the replay measured: 30 closed bars of
 * the higher of the two bias timeframes (H4 on M15 = 480), and some to spare.
 * Coinbase and OKX stop at 300, so they are passed over for one that does not.
 */
export const minHistory = (tf) => Math.ceil((30 * tfInfo(tf).htf[1].minutes) / tfInfo(tf).minutes) + 20;

/** No second alert for the same instrument and side within this many bars. */
export const COOLDOWN_BARS = 4;

/** Where an alert's price may drift (as a share of its stop) before `take` refuses it. */
export const DRIFT_SHARE = 0.25;

/** A typed MT5 price further than this from the feed's is a typo or the wrong instrument. */
export const PRICE_SANITY = 0.015;

const CONF = { firm: 'high', moderate: 'moderate', low: 'low' };

/**
 * The first target. The engine's is the next clustered level in the trade's
 * direction; with none, it falls back to exactly 1R, which can never pay the
 * risk after costs, so checkPlan() turns every such idea down. `targetRule`
 * says what to do then:
 *   'level'  keep the engine's targets — no level ahead means no idea
 *   '1.5R' / '2R'  when NO level stands in the way, aim that far instead.
 * A level closer than that is never skipped: it is where the move may stop.
 *
 * '1.5R' is the user's choice (11 Oct 2026), after desk/replay.mjs over
 * bitcoin's 2026 (1 Jan – 11 Oct, London window, $6 spread). With this
 * file's alert rules as they now are: 'level' 50 alerts, +0.04R a trade
 * (95% range, clustered by day, −0.35 to +0.43); '1.5R' 120 alerts, +0.03R
 * (−0.17 to +0.23); '2R' 117, +0.04R (−0.17 to +0.25). Roughly break-even
 * after the spread: no rule shows an edge. 1.5R gives about three alerts a
 * week for a demo record and reaches its target more often than 2R. It is
 * not evidence that the alerts make money.
 */
export const TARGET_RULE = '1.5R';
export function clearPathTarget(a, rule = TARGET_RULE) {
  const t = a.targets || [];
  const k = rule === '1.5R' ? 1.5 : rule === '2R' ? 2 : null;
  if (!k || !a.stopDistance) return t;
  const ahead = (a.levels || []).filter((L) => (a.bias === 'long' ? L.price > a.price : L.price < a.price));
  if (ahead.length) return t;
  const price = a.bias === 'long' ? a.price + k * a.stopDistance : a.price - k * a.stopDistance;
  return [{ price, basis: `${k}R — no level stands in the way` }];
}

/** The bar that closes next after `nowMs`, plus `lagMs` for the feeds to settle. */
export function nextPollMs(nowMs, tf, lagMs = 20000) {
  const ms = tfInfo(tf).minutes * 60000;
  return Math.floor(nowMs / ms) * ms + ms + lagMs;
}

/** Whether the watcher should be looking now: the user's window on a weekday, unless told otherwise. */
export function inWatchHours(nowMs, cfg, anytime = false) {
  if (anytime) return true;
  const w = windowState(nowMs, cfg.window);
  return w.open && w.phase !== 'weekend';
}

/**
 * The engine's read turned into the plan shape checkPlan() takes, so a live
 * idea is held to exactly the rules a screenshot idea is. The "chart" is the
 * engine's own window of bars; its first target is the engine's first.
 */
export function toPlan(a, pair, window, tf, targetRule = TARGET_RULE) {
  const lows = window.map((b) => b.l), highs = window.map((b) => b.h);
  const t = clearPathTarget(a, targetRule);
  return {
    decision: a.bias === 'long' ? 'buy' : a.bias === 'short' ? 'sell' : 'no_trade',
    instrument_seen: pair, timeframe_seen: tfInfo(tf).id,
    // The "visible chart" check exists for misread screenshots. Here the levels
    // come from the bars themselves, so the axis is simply wide enough to hold them.
    price_now: a.price,
    axis_low: Math.min(...lows, ...[a.invalidation, ...t.map((x) => x.price)].filter((x) => x > 0)),
    axis_high: Math.max(...highs, ...[a.invalidation, ...t.map((x) => x.price)].filter((x) => x > 0)),
    stop_loss: a.invalidation ?? null,
    take_profit_1: t[0] ? t[0].price : null,
    take_profit_2: t[1] ? t[1].price : null,
    confidence: CONF[a.confidenceLabel] || 'low',
    summary: '',
    reasons: (a.reasons || []).map((r) => r.text).slice(0, 3),
    against: (a.whyNot || []).slice(0, 3),
    invalidated_if: a.invalidationBasis || '',
  };
}

/**
 * One read of one instrument at one moment.
 *   kind  'no-data'  too few closed bars
 *         'stale'    the feed's newest closed bar is too old (market shut, feed stuck)
 *         'blocked'  the gate says no, or would need a spread the watcher cannot know
 *         'none'     the engine sees no directional read
 *         'rejected' it leaned, but the idea failed a check
 *         'idea'     it passed every check
 *
 * Two options exist for the history replay (desk/reads.mjs); live callers
 * leave both alone and get exactly the watcher's read:
 *   spreadNum  the spread the read assumes. Default: the instrument's confirmed
 *              usual spread. It is not only a cost line: it feeds the engine's
 *              spread verdict, checkPlan's stop floor (10x the cost) and netR,
 *              so a replay of years when bitcoin cost a fraction of $84,400 must
 *              be able to say what the spread was then (LEARNING-PLAN.md,
 *              engineering review).
 *   calendar   'full' | 'rules' | 'none' — which news events exist (gate and
 *              engine both; news-calendar.js CALENDAR_MODES).
 * Every read past the gate records `blackoutId` (the event whose blackout was
 * in force, or null) and `spreadNum` (the spread it used).
 */
export function liveRead({ pair, bars, nowMs, cfg, plan = null, source = null, targetRule = TARGET_RULE, spreadNum = null, calendar = 'full' }) {
  const core = engineRead({ pair, bars, nowMs, cfg, source, spreadNum, calendar });
  if (core.done) return core.done;
  const { result } = judgeLean(core, targetRule);
  if (result.decision !== 'buy' && result.decision !== 'sell') return { ...core.out, kind: 'rejected', result };
  return { ...core.out, kind: 'idea', result, plan };
}

/**
 * liveRead's first half: everything up to and including the engine, which
 * does not depend on the target rule. `done` is the finished read when there
 * is nothing to judge (no-data, stale, blocked, none); otherwise `out` is the
 * read so far and `a`, `window` what judgeLean needs. Split out so the replay
 * can run the engine once and judge the same lean under every target rule.
 */
export function engineRead({ pair, bars, nowMs, cfg, source = null, spreadNum = null, calendar = 'full' }) {
  const tf = tfInfo(timeframeFor(cfg));
  const inst = INSTRUMENTS[pair];
  const closed = closedBars(bars || [], tf.minutes, nowMs);
  const base = { pair, tf: tf.id, nowMs, source };
  if (closed.length < Math.max(MIN_BARS, minHistory(tf.id) - 1)) return { done: { ...base, kind: 'no-data', reason: `only ${closed.length} closed ${tf.id} bars from the feed, too few for the ${tf.htf[1].id} trend` } };
  const last = closed[closed.length - 1];
  const lastCloseMs = last.t + tf.minutes * 60000;
  if (nowMs - lastCloseMs > 2 * tf.minutes * 60000) {
    return { done: { ...base, kind: 'stale', lastCloseMs, reason: `the feed's newest closed bar ended at ${formatHM(lastCloseMs, cfg.window.tz)} London` } };
  }

  // Looked up once and handed to both the gate and the engine (it used to be
  // computed in each, identically, and was a large share of a replay's time).
  const blackout = getActiveBlackout(nowMs, pair, {}, { calendar });
  const blackoutId = blackout ? blackout.event.id : null;
  const gate = gateFor(pair, nowMs, cfg, tf.id, { calendar, blackout });
  if (!gate.allowed) return { done: { ...base, kind: 'blocked', gate, blackoutId } };
  // The screenshot path asks for the spread here; the watcher cannot, so it waits.
  if (gate.needsSpread) return { done: { ...base, kind: 'blocked', gate, spreadUnknown: true, blackoutId } };

  const spread = Number.isFinite(spreadNum) ? spreadNum : inst.typicalSpread.observed;
  const { cost } = costFor(pair, spread, cfg);
  const lastStretch = windowState(nowMs, cfg.window).phase === 'last-30';
  let session = { ...sessionQuality(nowMs, pair, cfg.window), lastStretch };
  // Bitcoin is read at any hour its market is open (decision 23): its quiet
  // hours mark the read down through the engine's own volatility checks, not
  // by withholding it. Gold's dead zone never reaches here — the gate stops it.
  if (pair === 'BTCUSD' && session.band === 'dead') session = { ...session, band: 'red' };

  const window = closed.slice(-ENGINE_BARS);
  const a = analyse({
    bars: window, htfBars: closed, instrument: inst, spread,
    blackout, session, nowMs, timeframe: tf.id,
  });
  const out = { ...base, gate, analysis: a, spreadNum: spread, cost, barCloseMs: lastCloseMs, price: a.price, cfgWindow: cfg.window, blackoutId };
  if (a.state !== 'read' || (a.bias !== 'long' && a.bias !== 'short')) return { done: { ...out, kind: 'none' }, out, a, window, closed };
  return { done: null, out, a, window, closed, pair, tf: tf.id, inst, cost };
}

/**
 * liveRead's second half: a lean from engineRead, under one target rule,
 * through the plan shape and checkPlan(). Returns both: `result` is
 * checkPlan's verdict, `plan` the levels it judged (a rejected idea's levels
 * live only there).
 */
export function judgeLean(core, targetRule = TARGET_RULE) {
  const { a, window, pair, tf, inst, cost } = core;
  const p = toPlan(a, pair, window, tf, targetRule);
  // lastStretch is false here on purpose: the engine has already marked the
  // read down for the final stretch (×0.6). checkPlan's own step-down is for
  // screenshots, which have no engine; doing both turned every 15:30 and
  // 15:45 alert into a "low" that `take` then had to refuse.
  const result = checkPlan(p, [], {
    priceNow: a.price, cost, digits: digitsOf(pair), pair, minStopPct: inst.minStopPct,
    asked: 0, lastStretch: false, timeframe: tf,
  });
  return { plan: p, result };
}

/**
 * Is an earlier alert on this instrument still running on the feed — neither
 * its stop nor its target touched since, and its day's window not yet closed?
 * Bars are the feed's closed bars; a sell's levels trigger on the ask.
 */
export function stillRunning(prev, bars, nowMs, cfg, spread = 0) {
  if (!prev || !(prev.stopDist > 0) || !(prev.refPrice > 0)) return false;
  if (nowMs >= windowState(prev.barCloseMs, cfg.window).closesAtMs) return false;
  const buy = prev.side === 'buy';
  const sl = buy ? prev.refPrice - prev.stopDist : prev.refPrice + prev.stopDist;
  const tp = prev.tp1Dist > 0 ? (buy ? prev.refPrice + prev.tp1Dist : prev.refPrice - prev.tp1Dist) : null;
  for (const b of bars) {
    if (b.t < prev.barCloseMs) continue;
    const lo = buy ? b.l : b.l + spread, hi = buy ? b.h : b.h + spread;
    if (buy ? lo <= sl : hi >= sl) return false;
    if (tp !== null && (buy ? hi >= tp : lo <= tp)) return false;
  }
  return true;
}

/**
 * Should this idea be sent? Not for a bar already alerted; not on the same
 * side within the cooldown; and not while an earlier alert on this instrument
 * is still running on the feed — four overlapping alerts, each saying "1% of
 * the account", were 3-4% on one move (found in review, 11 Oct 2026). `bars`
 * are the closed bars the read was taken from.
 */
export function shouldAlert(state, r, bars = [], cfg = null) {
  const prev = state && state.lastAlert && state.lastAlert[r.pair];
  if (!prev) return true;
  if (prev.barCloseMs === r.barCloseMs) return false;
  if (cfg && stillRunning(prev, bars, r.nowMs, cfg, r.spreadNum || 0)) return false;
  const cooldownMs = COOLDOWN_BARS * tfInfo(r.tf).minutes * 60000;
  return !(prev.side === r.result.decision && r.barCloseMs - prev.barCloseMs < cooldownMs);
}

/** What the alert state keeps of an alert: enough to tell when it has run its course. */
export const alertState = (rec) => ({ side: rec.side, barCloseMs: rec.barCloseMs, refPrice: rec.refPrice, stopDist: rec.stopDist, tp1Dist: rec.tp1Dist });

/** What is kept of an alert so `take` can turn it into a ticket from the user's own price. */
export function ideaRecord(r) {
  const res = r.result;
  const dist = (x) => (x === null || x === undefined ? null : Math.abs(x - res.entry));
  return {
    pair: r.pair, tf: r.tf, side: res.decision, refPrice: res.entry,
    source: r.source ? r.source.label : null, sourceId: r.source ? r.source.id : null,
    // Already marked down if it came in the final stretch; `take` must not do it twice.
    lastStretch: r.gate ? windowState(r.nowMs, r.cfgWindow).phase === 'last-30' : false,
    stopDist: res.stopDistance, tp1Dist: dist(res.takeProfit1), tp2Dist: dist(res.takeProfit2),
    netR: res.netR, confidence: res.confidence, reasons: res.reasons, against: res.against,
    caution: r.gate && r.gate.state === 'caution' ? r.gate.message : null,
    spreadNum: r.spreadNum, barCloseMs: r.barCloseMs,
    // Good for one bar after the one it was read from closed.
    validUntilMs: r.barCloseMs + tfInfo(r.tf).minutes * 60000,
  };
}

const side = (s) => (s === 'buy' ? { word: 'Buy', arrow: '▲', away: 'below', toward: 'above' } : { word: 'Sell', arrow: '▼', away: 'above', toward: 'below' });

/** The alert: distances from the user's own entry, a lot size, and how to get the exact ticket. */
export function formatLiveIdea(rec, cfg, nowMs, plan = null) {
  const pair = rec.pair;
  const d = digitsOf(pair);
  const t = tfInfo(rec.tf);
  const s = side(rec.side);
  const tz = cfg.window.tz;
  const out = [`**${s.arrow} ${s.word} idea · ${label(pair)} · live ${t.id} chart**`];
  if (rec.caution) out.push(`⚠ ${forChat(rec.caution)}`);
  out.push(`Read at the ${formatHM(rec.barCloseMs, tz)} London close of the ${t.words} chart from ${rec.source || 'the price feed'}, at ${fmt(rec.refPrice, d)} — not your broker's price, so the levels are distances from your own entry:`);
  out.push([
    `- Stop loss **${fmt(rec.stopDist, d)} ${s.away}** your entry`,
    `- Take profit **${fmt(rec.tp1Dist, d)} ${s.toward}** (pays ${rec.netR}× the risk after the usual spread${pair === 'XAUUSD' ? ' and commission' : ''})`,
    ...(rec.tp2Dist ? [`- Next level ${fmt(rec.tp2Dist, d)} ${s.toward}, if you later move your target by hand`] : []),
  ].join('\n'));
  const sized = sizeFor({ pair, cfg, stop: rec.stopDist, entry: rec.refPrice, spreadNum: rec.spreadNum });
  if (sized.r.ok && sized.r.cfd.lots > 0) {
    out.push([`Volume **${sized.r.cfd.lots.toFixed(2)}** lots. ${riskLine(sized, cfg)}`, ...sizeWarnings(sized)].join('\n'));
  } else if (sized.r.ok) {
    out.push('At this balance and risk the stop comes to less than the minimum lot, so there is no volume to give.');
  }
  out.push(`**To take it, send me your MT5 price now** and I'll give you the exact stop loss and take profit. It is good until ${formatHM(rec.validUntilMs, tz)} London, and only while the price stays within ${fmt(rec.stopDist * DRIFT_SHARE, d)} of where it was read. Confidence: **${rec.confidence}**.${rec.lastStretch ? ' Final stretch — confidence is marked down.' : ''}`);
  const why = [];
  if (rec.reasons.length) why.push(`**For it:** ${rec.reasons.join('; ')}.`);
  if (rec.against.length) why.push(`**Against it:** ${rec.against.join(' ')}`);
  if (why.length) out.push(why.join('\n'));
  const tail = [nextNewsLine(nowMs, pair, cfg.window), planLine(plan, nowMs, cfg.window)].filter(Boolean);
  if (tail.length) out.push(tail.join('\n'));
  out.push('_From the live chart, not your screenshot, and not your broker\'s price. It has no track record, and the decision is yours._');
  return out.join('\n\n');
}

/**
 * What a one-off `scan` says when there is no idea. It never names the lean
 * the engine had, its levels, or a rejected idea's direction (decisions 2, 22).
 */
export function formatLiveNone(r, cfg) {
  const t = tfInfo(r.tf);
  const head = `**■ No idea · ${label(r.pair)} · live ${t.id} chart**`;
  const at = `At ${formatHM(r.nowMs, cfg.window.tz)} London`;
  if (r.kind === 'blocked' && !r.spreadUnknown) return `**■ ${gateWord(r.gate)} · ${label(r.pair)}**\n\n${forChat(r.gate.message)}`;
  if (r.kind === 'blocked') return `${head}\n\n${forChat(cautionAfter(r.gate.message))} The watcher does not send ideas then: it cannot see the spread. Send a screenshot with the spread instead.`;
  if (r.kind === 'no-data' || r.kind === 'stale') return `${head}\n\n${at} the feed is not usable: ${r.reason}.`;
  if (r.kind === 'rejected') return `${head}\n\n${at} an idea was found, but it failed these checks:\n${r.result.problems.map((p) => `- ${forChat(p)}`).join('\n')}`;
  const regime = r.analysis && r.analysis.regime ? r.analysis.regime.regime : null;
  return `${head}\n\n${at} nothing on the ${t.words} chart passes the checks${regime ? ` (conditions: ${regime})` : ''}.`;
}

/**
 * `take`: the stored alert, rebuilt around the price the user typed from MT5.
 * Refused when it is past its bar, when the feed has moved more than a
 * quarter of the stop since, when the gate now says no, or when the rebuilt
 * idea fails the same checks with the spread the user gave.
 */
export function takeIdea({ rec, priceNow, livePrice, nowMs, cfg, spreadNum = null, typedSpread = false }) {
  const pair = rec.pair;
  const d = digitsOf(pair);
  const inst = INSTRUMENTS[pair];
  if (nowMs > rec.validUntilMs) {
    return { ok: false, text: `That ${label(pair).toLowerCase()} idea ran out at ${formatHM(rec.validUntilMs, cfg.window.tz)} London. Wait for the next alert, or send a screenshot.` };
  }
  if (!(livePrice > 0)) {
    return { ok: false, text: 'I could not check the live price just now, so I cannot tell whether the idea still holds. Send a screenshot instead, or try again in a minute.' };
  }
  // A typo, or the other instrument's price: the broker and the feed differ, but not by this much.
  if (Math.abs(priceNow - livePrice) / livePrice > PRICE_SANITY) {
    return { ok: false, text: `${fmt(priceNow, d)} is a long way from the live ${label(pair).toLowerCase()} price (about ${fmt(livePrice, d)}). Check the number, and that it is the ${label(pair).toLowerCase()} price on MT5's Quotes tab.` };
  }
  const drift = Math.abs(livePrice - rec.refPrice);
  if (drift > rec.stopDist * DRIFT_SHARE) {
    return { ok: false, text: `Price has moved ${fmt(drift, d)} since the alert — more than a quarter of the ${fmt(rec.stopDist, d)} stop — so the idea no longer matches. Wait for the next one.` };
  }
  const gate = gateFor(pair, nowMs, cfg, rec.tf);
  if (!gate.allowed) return { ok: false, text: `**■ ${gateWord(gate)} · ${label(pair)}**\n\n${forChat(gate.message)}` };
  if (gate.needsSpread && !typedSpread) return { ok: false, needSpread: true, text: `${forChat(gate.message)}\n\nWhat is the spread on MT5's Quotes tab now?` };

  const sp = spreadNum > 0 ? spreadNum : rec.spreadNum;
  const { cost } = costFor(pair, sp, cfg);
  const buy = rec.side === 'buy';
  const at = (dist, toward) => (dist === null ? null : buy === toward ? priceNow + dist : priceNow - dist);
  const sl = at(rec.stopDist, false), tp1 = at(rec.tp1Dist, true), tp2 = at(rec.tp2Dist, true);
  const span = Math.max(rec.stopDist, rec.tp1Dist, rec.tp2Dist || 0);
  const result = checkPlan({
    decision: rec.side, instrument_seen: pair, timeframe_seen: tfInfo(rec.tf).id, price_now: priceNow,
    axis_low: priceNow - span, axis_high: priceNow + span, stop_loss: sl, take_profit_1: tp1, take_profit_2: tp2,
    confidence: rec.confidence, reasons: rec.reasons, against: rec.against,
  }, [], {
    priceNow, cost, digits: d, pair, minStopPct: inst.minStopPct, asked: 0,
    lastStretch: !rec.lastStretch && windowState(nowMs, cfg.window).phase === 'last-30', timeframe: rec.tf,
  });
  if (result.decision !== rec.side) {
    return { ok: false, text: `At your price, with that spread, it no longer passes:\n${result.problems.map((p) => `- ${forChat(p)}`).join('\n')}` };
  }
  const sized = sizeFor({ pair, cfg, stop: rec.stopDist, entry: priceNow, spreadNum: sp, side: rec.side, stopLoss: result.stopLoss, target: result.takeProfit1 });
  const lines = [`**${side(rec.side).arrow} ${side(rec.side).word} idea · ${label(pair)}** — market order at your ${fmt(priceNow, d)}`];
  if (gate.state === 'caution') lines.push(`⚠ ${forChat(cautionAfter(gate.message))}`);
  lines.push(ticketLines(sized, pair, cfg).join('\n'));
  if (result.takeProfit2) lines.push(`Next level ${fmt(result.takeProfit2, d)} — not on the ticket.`);
  lines.push('_Check the levels on your MT5 chart before you place it. The decision is yours._');
  return { ok: true, text: lines.join('\n\n'), result };
}
