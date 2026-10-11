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
 * bitcoin's 2026 (1 Jan – 11 Oct, London window, $6 spread): 'level' 57
 * alerts, +0.10R a trade (95% range −0.33 to +0.53); '1.5R' 175 alerts,
 * +0.08R (−0.09 to +0.24); '2R' the same 175, +0.10R (−0.07 to +0.27). No
 * rule showed an edge; 1.5R was chosen for alerts about once a trading day
 * (a demo record that grows faster) and reaching its target more often than
 * 2R. It is not evidence that the alerts make money.
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
 */
export function liveRead({ pair, bars, nowMs, cfg, plan = null, source = null, targetRule = TARGET_RULE }) {
  const tf = tfInfo(timeframeFor(cfg));
  const inst = INSTRUMENTS[pair];
  const closed = closedBars(bars || [], tf.minutes, nowMs);
  const base = { pair, tf: tf.id, nowMs, source };
  if (closed.length < MIN_BARS) return { ...base, kind: 'no-data', reason: `only ${closed.length} closed ${tf.id} bars from the feed` };
  const last = closed[closed.length - 1];
  const lastCloseMs = last.t + tf.minutes * 60000;
  if (nowMs - lastCloseMs > 2 * tf.minutes * 60000) {
    return { ...base, kind: 'stale', lastCloseMs, reason: `the feed's newest closed bar ended at ${formatHM(lastCloseMs, cfg.window.tz)} London` };
  }

  const gate = gateFor(pair, nowMs, cfg, tf.id);
  if (!gate.allowed) return { ...base, kind: 'blocked', gate };
  // The screenshot path asks for the spread here; the watcher cannot, so it waits.
  if (gate.needsSpread) return { ...base, kind: 'blocked', gate, spreadUnknown: true };

  const spreadNum = inst.typicalSpread.observed;
  const { cost } = costFor(pair, spreadNum, cfg);
  const lastStretch = windowState(nowMs, cfg.window).phase === 'last-30';
  let session = { ...sessionQuality(nowMs, pair, cfg.window), lastStretch };
  // Bitcoin is read at any hour its market is open (decision 23): its quiet
  // hours mark the read down through the engine's own volatility checks, not
  // by withholding it. Gold's dead zone never reaches here — the gate stops it.
  if (pair === 'BTCUSD' && session.band === 'dead') session = { ...session, band: 'red' };

  const window = closed.slice(-ENGINE_BARS);
  const a = analyse({
    bars: window, htfBars: closed, instrument: inst, spread: spreadNum,
    blackout: getActiveBlackout(nowMs, pair, {}), session, nowMs, timeframe: tf.id,
  });
  const out = { ...base, gate, analysis: a, spreadNum, cost, barCloseMs: lastCloseMs, price: a.price, cfgWindow: cfg.window };
  if (a.state !== 'read' || (a.bias !== 'long' && a.bias !== 'short')) return { ...out, kind: 'none' };

  const p = toPlan(a, pair, window, tf.id, targetRule);
  const result = checkPlan(p, [], {
    priceNow: a.price, cost, digits: digitsOf(pair), pair, minStopPct: inst.minStopPct,
    asked: 0, lastStretch, timeframe: tf.id,
  });
  if (result.decision !== 'buy' && result.decision !== 'sell') return { ...out, kind: 'rejected', result };
  return { ...out, kind: 'idea', result, plan };
}

/** Has this instrument already had an alert on this side within the cooldown? */
export function shouldAlert(state, r) {
  const prev = state && state.lastAlert && state.lastAlert[r.pair];
  if (!prev) return true;
  if (prev.barCloseMs === r.barCloseMs) return false;
  const cooldownMs = COOLDOWN_BARS * tfInfo(r.tf).minutes * 60000;
  return !(prev.side === r.result.decision && r.barCloseMs - prev.barCloseMs < cooldownMs);
}

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
  out.push(`**To take it, send me your MT5 price now** and I'll give you the exact stop loss and take profit. It is good until ${formatHM(rec.validUntilMs, tz)} London, and only while the price stays within ${fmt(rec.stopDist * DRIFT_SHARE, d)} of where it was read. Confidence: **${rec.confidence}**.`);
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
