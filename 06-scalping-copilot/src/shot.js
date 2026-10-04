/**
 * shot.js — reading a screenshot of the user's MT5 chart.
 *
 * Why this exists. Inside claude.ai the page cannot reach any price feed (its
 * security policy blocks outside connections — confirmed on the user's iPhone,
 * 27 Sep 2026), and the user chose to keep it there. What the page CAN do is
 * send a picture to Claude on the user's own account, through the artifact
 * `sample` capability. So the user screenshots the M5 chart in MT5 and the
 * page asks for a trade idea.
 *
 * How it is read. Three analysts look at the same picture independently, each
 * through a different lens, then a head trader reconciles them against the
 * picture. They are the same model under different instructions, so agreement
 * catches one reader's slip, not a shared mistake — which is why the one check
 * that does not depend on reading pixels, the price the user types from MT5,
 * is required.
 *
 * What this file decides, and the model does not. Everything here is plain
 * code the model cannot argue with:
 *  - the gate: no analysis at all when the market is shut, in a news blackout,
 *    or in the weekday dead zone (decision 2) — and no usage spent;
 *  - the check: every plan becomes "No trade", with the reason shown, unless
 *    it is a market order on the instrument and timeframe selected, read at the
 *    price the user typed, with the stop on the right side and clear of both
 *    costs and ordinary five-minute noise, and a first target that pays at
 *    least the risk after the full cost of the trade.
 *
 * This is the one place the tool says buy or sell. The user asked for it
 * (27 Sep 2026), knowing the earlier design deliberately never did. It is
 * framed as an idea from a picture, never as a signal, and "No trade" is the
 * answer whenever the reading is not clean.
 */
import { formatHM } from './timezone.js';

/** How old an analysis may be before the ticket stops using it. */
export const SHOT_MAX_AGE_MS = 15 * 60000;

/** The three lenses. Each analyst sees the same picture and context, and only one of these. */
export const LENSES = [
  {
    id: 'structure',
    name: 'Trend and structure',
    brief: 'trend and market structure: the sequence of swing highs and lows, any break of structure or change of character, where the current leg began, and the swing that would prove a trade in that direction wrong.',
  },
  {
    id: 'levels',
    name: 'Levels and liquidity',
    brief: 'levels and liquidity: support and resistance with more than one touch, round numbers, the recent highs and lows that stops will sit beyond, sweeps of those levels that were then reclaimed, and whether price is at the edge or in the middle of its range.',
  },
  {
    id: 'momentum',
    name: 'Momentum and risk',
    brief: 'momentum and risk: candle size and speed, any indicators drawn on the chart (moving averages, RSI and so on — ignore what is not there), whether the move is stretched, a stop distance that fits the recent candle ranges, and whether the reward clearly covers the cost of the trade.',
  },
];

const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };

/**
 * Is the broker's market open now, from the confirmed session times in server
 * time? Null when the server clock is not set (the caller then assumes open).
 * Gold trades Monday to Friday, 01:02-23:59 server (Friday to 23:57); bitcoin
 * every day 00:05-23:59 (Friday to 23:55, Saturday from 00:45).
 */
export function marketOpenNow(inst, nowMs, serverOffsetHours) {
  const ss = inst && inst.sessionServer;
  if (!ss || serverOffsetHours === null || serverOffsetHours === undefined || serverOffsetHours === '') return null;
  const d = new Date(nowMs + Number(serverOffsetHours) * 3600e3);   // server wall time, read through UTC fields
  const dow = d.getUTCDay();
  const t = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (!inst.tradesAroundTheClock && (dow === 0 || dow === 6)) return false;
  const open = dow === 6 && ss.saturdayOpen ? hm(ss.saturdayOpen) : hm(ss.open);
  const close = dow === 5 && ss.fridayClose ? hm(ss.fridayClose) : hm(ss.close);
  return t >= open && t <= close;
}

/**
 * Whether to analyse at all, decided before any usage is spent.
 *   closed      the broker's market is shut (weekend gold, a daily break)
 *   stand-aside a scheduled release is inside its blackout (gold)
 *   stand-down  the weekday dead zone (gold — decision 2)
 *   caution     allowed, with a warning: weekend, outside the window, a major
 *               release due soon, or (bitcoin) a release blackout
 *   ok          allowed
 *
 * Bitcoin is analysed at any hour the broker's market is open (the user's
 * request, 4 Oct 2026): its quiet hours and the trading window no longer
 * stop it, and a release blackout becomes a warning rather than a block. Only
 * a closed market still stops it, because MT5 cannot take an order then.
 */
export function shotGate({ pair, weekend, blackout, band, insideWindow, win, marketOpen = null, bandEndsAtMs = null, nextMajor = null, nowMs = 0 }) {
  if (marketOpen === false || (pair === 'XAUUSD' && weekend)) {
    return {
      allowed: false, state: 'closed',
      message: pair === 'XAUUSD' && weekend
        ? 'Gold is closed at the weekend. Switch to Bitcoin, or come back on Monday.'
        : 'Your broker\'s market is shut right now (its daily break). There is nothing to trade.',
    };
  }
  const anyTime = pair === 'BTCUSD';
  if (blackout && blackout.active && anyTime) {
    const clear = blackout.endsAtMs && win ? ` The usual all-clear is ${formatHM(blackout.endsAtMs, win.tz)}.` : '';
    return {
      allowed: true, state: 'caution', needsSpread: true,
      message: `${blackout.event.name} ${blackout.phase === 'before' ? 'is about to be released' : 'has just been released'}: spreads can jump and stops can slip past their level. Type the spread as it is right now.${clear}`,
    };
  }
  if (blackout && blackout.active) {
    const clear = blackout.endsAtMs && win ? ` Clear at ${formatHM(blackout.endsAtMs, win.tz)}.` : '';
    return {
      allowed: false, state: 'stand-aside',
      message: `${blackout.event.name} ${blackout.phase === 'before' ? 'is about to be released' : 'has just been released'}. Stand aside.${clear}`,
    };
  }
  if (band === 'dead' && !weekend && !anyTime) {
    const until = bandEndsAtMs && win ? ` until ${formatHM(bandEndsAtMs, win.tz)}` : '';
    return {
      allowed: false, state: 'stand-down',
      message: `Quiet hours for this instrument${until}: the moves are too small for the costs, so no screenshot is analysed${until ? ' until then' : ''}.`,
    };
  }
  const soon = nextMajor && nextMajor.ts > nowMs && nextMajor.ts - nowMs < 30 * 60000;
  if (weekend || !insideWindow || soon) {
    const parts = [];
    if (soon) parts.push(`${nextMajor.short || nextMajor.name} is at ${win ? formatHM(nextMajor.ts, win.tz) : 'soon'}: a trade opened now may still be open when it lands.`);
    if (weekend) parts.push('Weekend: bitcoin trades, but liquidity is thin and the spread can widen — type today\'s spread before you analyse.');
    else if (!insideWindow) parts.push('Outside your trading hours — type the spread from MT5 before you analyse.');
    return { allowed: true, state: 'caution', message: parts.join(' '), needsSpread: weekend || !insideWindow };
  }
  return { allowed: true, state: 'ok', message: null, needsSpread: false };
}

/** The context every reader gets, as plain lines. Kept small: it is re-sent with every call. */
export function contextLines(c) {
  const lines = [
    `Instrument selected in the trader's tool: ${c.pair} (${c.pair === 'XAUUSD' ? 'gold' : 'bitcoin'}, quoted to ${c.digits} decimals).`,
    'Intended chart: MetaTrader 5, M5 (five-minute candles). Chart prices are BID prices; a sell\'s stop loss and take profit are triggered on the ask, one spread higher.',
    `Current price, typed by the trader from MT5: ${c.priceNow}. This is the price a market order fills near.`,
    `Time now: ${c.nowText} London (${c.weekday}); the MT5 chart clock reads ${c.chartClock || 'unknown'}. Session: ${c.sessionName}.`,
    `Cost of one trade: spread about ${c.spread} (${c.spreadSource})${c.commission > 0 ? ` plus commission worth about ${c.commission} in price` : ''}, so about ${c.cost} in total.`,
    `The stop must be at least ${c.stopFloor} from the entry — clear of the costs and of ordinary five-minute noise.`,
    c.news.length
      ? `Scheduled releases in the next 90 minutes: ${c.news.join('; ')}. If one is within 30 minutes, prefer no trade unless take profit 1 is close enough to be reached before it.`
      : 'No scheduled releases in the next 90 minutes.',
  ];
  if (c.caution) lines.push(`Caution: ${c.caution}`);
  if (c.planSetups && c.planSetups.length) {
    lines.push(`The trader's plan today: setups ${c.planSetups.join(', ')}; ${c.tradesTaken} of ${c.maxTrades} planned trades taken.`);
  }
  lines.push('Never mention how much time is left in the trader\'s session.');
  return lines;
}

// Shape only, and a no-trade example: a filled-in trade here would be a
// plausible plan a reader who cannot see the axis could simply copy.
const ANALYST_JSON = '{"readable": true, "instrument_seen": "<symbol as printed on the chart>", "timeframe_seen": "<as printed, e.g. M5>", "price_now": <number>, "axis_low": <number>, "axis_high": <number>, "view": "none", "stop_loss": null, "take_profit_1": null, "take_profit_2": null, "confidence": <0 to 1>, "reasons": ["<short>"], "against": ["<short>"]}';

const READ_RULES = (c) => [
  `1. Check the chart. If it is not ${c.pair}, or its timeframe is not M5, or you cannot read the price scale, set "readable": false and stop there. If the time axis clearly shows the chart ending more than 15 minutes before the chart clock, it is an old screenshot: set "readable": false.`,
  '2. Read the current BID price: the highlighted tag on the right-hand axis level with the last candle\'s close. If two tags sit close together, the lower is the bid and the upper the ask. Ignore tags for open positions, pending orders, stop loss and take profit lines, drawn lines and the crosshair. Read the lowest and highest labels on the price scale.',
];

/** The prompt for one analyst. */
export function analystPrompt(lens, c) {
  return [
    `You are one of three independent analysts reading a screenshot of a MetaTrader 5 chart for a trader who scalps the five-minute chart. Your lens is ${lens.brief}`,
    '',
    'Context from the trader\'s tool (reliable):',
    ...contextLines(c).map((l) => `- ${l}`),
    '',
    'Work through it in this order:',
    ...READ_RULES(c),
    '3. Read the chart through your lens.',
    '4. Decide "buy", "sell" or "none". Choose "none" whenever the picture is unclear or mixed, price is in the middle of its range, or the reward does not clearly exceed the risk after the cost. "none" is a good answer, not a failure.',
    `5. For buy or sell, the entry is a market order at the current price (this tool cannot place limit orders). Give a stop loss beyond the structure that would prove the idea wrong, at least ${c.stopFloor} from the entry; for a sell, put it at least one spread above that structure. Give take_profit_1 at a real level you can see, paying at least the risk after the cost. take_profit_2 is optional: give it only if a second real level is visible, otherwise null. Read every level off the price scale; never invent one.`,
    '',
    'Reply with only one JSON object in this shape (this example is a "none"):',
    ANALYST_JSON,
    'Prices are numbers. Use null for the stop and targets when "view" is "none". At most three short plain-English items in "reasons" and in "against".',
  ].join('\n');
}

const PLAN_JSON = '{"decision": "no_trade", "instrument_seen": "<symbol as printed>", "timeframe_seen": "<as printed>", "price_now": <number>, "axis_low": <number>, "axis_high": <number>, "stop_loss": null, "take_profit_1": null, "take_profit_2": null, "confidence": "low", "summary": "<one or two plain sentences>", "reasons": ["<short>"], "against": ["<short>"], "invalidated_if": "<plain words, or empty>"}';

const PLAN_RULES = (c) => [
  `- A trade is a market order at the current price. The stop loss sits beyond the structure that proves it wrong, at least ${c.stopFloor} from the entry; a sell's stop sits at least one spread above that structure.`,
  '- Take profit 1 must pay at least as much as the stop risks, after the full cost. Take profit 2, if any, is the next real level beyond it; otherwise null.',
  '- Prefer "no_trade" to a marginal trade; a trade you would call low confidence is a "no_trade". Do not claim certainty: this is an idea from a picture.',
  '- For "no_trade", the summary says only why there is no trade. It names no direction and no levels.',
];

/** The prompt for the head trader, who sees the picture and all the readings. */
export function headPrompt(readings, c) {
  const shown = readings.map((r, i) => {
    const { lens, ...rest } = r;
    return `Analyst ${i + 1} (${lens || (LENSES[i] ? LENSES[i].name : 'analyst')}): ${JSON.stringify(rest)}`;
  });
  return [
    `You are the head trader. ${readings.length} analysts independently read the attached screenshot of a MetaTrader 5 chart for a five-minute scalper. Decide the final plan.`,
    '',
    'Context from the trader\'s tool (reliable):',
    ...contextLines(c).map((l) => `- ${l}`),
    '',
    'Their readings:',
    ...shown,
    '',
    'Rules:',
    '- Look at the chart yourself and check every level they give against it.',
    '- If fewer than two analysts point the same way, or they read the current price differently, the answer is "no_trade".',
    ...PLAN_RULES(c),
    '',
    'Reply with only one JSON object in this shape (this example is a "no_trade"):',
    PLAN_JSON,
    '"decision" is "buy", "sell" or "no_trade"; "confidence" is "low", "moderate" or "high". Prices are numbers; use null for the stop and targets when the decision is "no_trade". At most three reasons and three items against, in plain English.',
  ].join('\n');
}

/** The single-reader prompt for the fast mode: one pass, the same rules as the head trader. */
export function fastPrompt(c) {
  return [
    'You are an experienced trader reading a screenshot of a MetaTrader 5 chart for a five-minute scalper. Give a plan in one pass.',
    '',
    'Context from the trader\'s tool (reliable):',
    ...contextLines(c).map((l) => `- ${l}`),
    '',
    ...READ_RULES(c).map((r) => r.replace('set "readable": false', 'the decision is "no_trade"').replace('set "readable": false', 'the decision is "no_trade"')),
    '3. Read structure, levels and momentum.',
    ...PLAN_RULES(c),
    '',
    'Reply with only one JSON object in this shape (this example is a "no_trade"):',
    PLAN_JSON,
    'Use null for the stop and targets when the decision is "no_trade".',
  ].join('\n');
}

/**
 * The same job as one pass of the page's readers, written for an ordinary
 * Claude chat, for a view where claude.ai will not let the page attach a
 * picture. The user pastes this into a chat with the screenshot, then pastes
 * the reply back, and checkPlan() applies the same rules to it.
 */
export function chatPrompt(c) {
  return [
    'I am attaching a screenshot of my MetaTrader 5 chart. I scalp the five-minute chart. Read it carefully, as three independent analysts would (trend and structure; levels and liquidity; momentum and risk), then decide as a head trader who checks their work against the picture.',
    '',
    'Context from my trading tool (reliable):',
    ...contextLines(c).map((l) => `- ${l}`),
    '',
    ...READ_RULES(c).map((r) => r.replace('set "readable": false', 'the decision is "no_trade"').replace('set "readable": false', 'the decision is "no_trade"')),
    '3. Read structure, levels and momentum.',
    ...PLAN_RULES(c),
    '',
    'Reply with ONLY one JSON object, no other text, in this shape (this example is a "no_trade"):',
    PLAN_JSON,
    'Use null for the stop and targets when the decision is "no_trade".',
  ].join('\n');
}

/** Read a plan pasted back from a chat: the whole text, a code fence, or the first { to the last }. */
export function parseReply(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const tries = [text.trim()];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) tries.push(fence[1].trim());
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
  for (const t of tries) {
    try { const v = JSON.parse(t); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* next */ }
  }
  return null;
}

const num = (x) => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x.replace(/,/g, '')) : NaN);
const round = (x, d) => +Number(x).toFixed(d);

export function median(xs) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/** Does a symbol as printed on the chart name the selected instrument? Unknown counts as a match. */
export function seesInstrument(seen, pair) {
  if (!seen || typeof seen !== 'string' || /^</.test(seen)) return true;
  const s = seen.toUpperCase().replace(/[^A-Z]/g, '');
  const keys = pair === 'XAUUSD' ? ['XAU', 'GOLD'] : ['BTC', 'XBT', 'BITCOIN'];
  return keys.some((k) => s.includes(k));
}
const onM5 = (seen) => !seen || typeof seen !== 'string' || /^</.test(seen) || /^\s*M5\s*$/i.test(seen) || /^\s*5\s*m(in)?\s*$/i.test(seen);

/** The stop floor for an instrument at a price: clear of the costs, and of ordinary five-minute noise. */
export function stopFloor(cost, price, minStopPct = 0) {
  return Math.max(10 * cost, 0.5 * minStopPct * price);
}

/**
 * Turn the head trader's plan into what the page shows, applying the rules
 * the model is not trusted to enforce on itself. Anything that fails becomes
 * "no_trade" with the reason, so the user sees why rather than a number. A
 * rejected idea's direction, summary and levels are not passed on.
 *
 *   plan      the head trader's (or fast reader's) JSON
 *   readings  the analysts' JSON (empty in fast mode)
 *   ctx       { priceNow, cost, digits, pair, minStopPct, asked, lastStretch }
 */
export function checkPlan(plan, readings = [], ctx = {}) {
  const { priceNow = null, cost = 0, digits = 2, pair = null, minStopPct = 0, asked = readings.length, lastStretch = false } = ctx;
  const problems = [];
  const good = readings.filter((r) => r && r.readable !== false);
  const agreementOf = (agree) => (asked ? { agree, of: good.length, asked } : null);

  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return { decision: 'no_trade', problems: ['The analysis came back empty.'], reasons: [], against: [], summary: '', agreement: null };
  }
  const decision = plan.decision === 'buy' || plan.decision === 'sell' ? plan.decision : 'no_trade';
  const agree = good.filter((r) => r.view === decision).length;
  const base = {
    reasons: listOf(plan.reasons), against: listOf(plan.against),
    confidence: ['low', 'moderate', 'high'].includes(plan.confidence) ? plan.confidence : 'low',
    summary: typeof plan.summary === 'string' ? plan.summary : '',
    invalidatedIf: typeof plan.invalidated_if === 'string' ? plan.invalidated_if : '',
    priceNow: priceNow > 0 ? round(priceNow, digits) : null,
  };
  if (decision === 'no_trade') return { ...base, decision, problems: [], agreement: agreementOf(agree) };

  // From here, a buy or sell that must earn its way onto the screen.
  const reject = () => ({
    decision: 'no_trade', rejected: true, problems, priceNow: base.priceNow,
    reasons: [], against: [], summary: '', invalidatedIf: '', confidence: base.confidence, agreement: agreementOf(agree),
  });

  if (!(priceNow > 0)) problems.push('The current price was not typed in.');
  if (asked && good.length < 2) problems.push('Fewer than two analysts could read the chart. Retake the screenshot with the price scale showing.');
  const seen = [...good.map((r) => r.instrument_seen), plan.instrument_seen];
  if (pair && seen.filter((s) => !seesInstrument(s, pair)).length >= (asked ? 2 : 1)) problems.push('This does not look like the instrument selected at the top. Check the screenshot matches it.');
  const frames = [...good.map((r) => r.timeframe_seen), plan.timeframe_seen];
  if (frames.filter((s) => !onM5(s)).length >= (asked ? 2 : 1)) problems.push('The chart is not on M5. Switch MT5 to the five-minute chart and take a new screenshot.');
  if (asked && agree < 2) problems.push(`Only ${agree} of ${asked} analysts agreed with the idea.`);
  if (plan.entry_type === 'limit') problems.push('A limit order was suggested. This page builds market orders only.');
  if (base.confidence === 'low') problems.push('The readers rated it low confidence.');

  const sl = num(plan.stop_loss), tp1 = num(plan.take_profit_1);
  let tp2 = num(plan.take_profit_2);
  if (!(priceNow > 0) || ![sl, tp1].every((x) => Number.isFinite(x) && x > 0)) {
    if (priceNow > 0) problems.push('The plan is missing a stop loss or take profit.');
    return reject();
  }
  const entry = priceNow;   // a market order fills at the current price, whatever the plan wrote
  const buy = decision === 'buy';
  if (buy ? !(sl < entry && entry < tp1) : !(tp1 < entry && entry < sl)) problems.push('The stop loss or take profit is on the wrong side of the current price.');

  const stopDist = Math.abs(entry - sl);
  const floor = stopFloor(cost, entry, minStopPct);
  if (stopDist < floor) problems.push(`The stop is only ${stopDist.toFixed(digits)} away. It needs at least ${floor.toFixed(digits)} to clear the costs and ordinary five-minute noise.`);
  const netR = (Math.abs(tp1 - entry) - cost) / (stopDist + cost);
  if (!(netR >= 1)) problems.push(`Take profit 1 pays ${Math.max(0, netR).toFixed(2)}× the risk after costs. It needs at least 1×.`);

  // The picture must show the price the trader typed: otherwise it is the
  // wrong chart, an old screenshot, or a misread scale.
  const tol = Math.max(3 * cost, 0.3 * stopDist);
  const reads = [...good.map((r) => num(r.price_now)), num(plan.price_now)].filter((x) => x > 0);
  const close = reads.filter((x) => Math.abs(x - entry) <= tol).length;
  if (!reads.length || close < Math.min(2, reads.length)) problems.push('The chart shows a different price from the one you typed. Take a fresh screenshot, and check it is the right instrument.');
  const planEntry = num(plan.entry);
  if (Number.isFinite(planEntry) && planEntry > 0 && Math.abs(planEntry - entry) > tol) problems.push('The plan was built for an entry away from the current price.');

  // Levels must be ones the chart actually shows (with a little room for targets).
  const lo = median([...good.map((r) => num(r.axis_low)), num(plan.axis_low)].filter((x) => x > 0));
  const hi = median([...good.map((r) => num(r.axis_high)), num(plan.axis_high)].filter((x) => x > 0));
  if (!(lo > 0 && hi > lo)) {
    problems.push('The price scale could not be read. Retake the screenshot with the price scale showing.');
  } else {
    const room = (hi - lo) * 0.25;
    const off = (x) => x < lo - room || x > hi + room;
    if ([sl, tp1].some(off)) problems.push('A level is outside the part of the chart the screenshot shows.');
    if (Number.isFinite(tp2) && off(tp2)) tp2 = NaN;
  }
  if (Number.isFinite(tp2) && tp2 > 0 && (buy ? tp2 <= tp1 : tp2 >= tp1)) tp2 = NaN;

  if (problems.length) return reject();

  // The final stretch marks confidence down; it never hides an idea (decision 1).
  const confidence = lastStretch ? { high: 'moderate', moderate: 'low', low: 'low' }[base.confidence] : base.confidence;
  return {
    ...base, decision, problems: [], agreement: agreementOf(agree), confidence,
    entry: round(entry, digits), stopLoss: round(sl, digits), takeProfit1: round(tp1, digits),
    takeProfit2: Number.isFinite(tp2) && tp2 > 0 ? round(tp2, digits) : null,
    stopDistance: round(stopDist, digits), netR: +netR.toFixed(2), cost,
  };
}

function listOf(x) {
  return Array.isArray(x) ? x.filter((s) => typeof s === 'string' && s.trim()).slice(0, 3) : [];
}

/** Is a stored analysis still usable for a ticket? The caller also applies the gate. */
export function shotIsFresh(shot, nowMs, pair) {
  return !!shot && shot.pair === pair && (nowMs - shot.atMs) <= SHOT_MAX_AGE_MS
    && (shot.result.decision === 'buy' || shot.result.decision === 'sell');
}
