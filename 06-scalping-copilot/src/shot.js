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
 * picture. Independence is the point: one reader's misread price axis or
 * invented level rarely survives two others and a referee.
 *
 * What this file decides, and the model does not. Everything here is plain
 * code the model cannot argue with:
 *  - the gate: no analysis at all in a news blackout, in the weekday dead
 *    zone (decision 2), or on gold at the weekend — and no usage spent;
 *  - the check: a plan that reads the price differently from the analysts,
 *    puts the stop on the wrong side, sits inside five spreads, pays less
 *    than 1:1 after the spread, or reaches outside the visible chart is
 *    turned into "No trade", with the reason shown.
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
    brief: 'Trend and market structure: the sequence of swing highs and lows, any break of structure or change of character, where the current leg began, and the swing that would prove a trade in that direction wrong.',
  },
  {
    id: 'levels',
    name: 'Levels and liquidity',
    brief: 'Levels and liquidity: support and resistance with more than one touch, round numbers, the recent highs and lows that stops will sit beyond, sweeps of those levels that were then reclaimed, and whether price is at the edge or in the middle of its range.',
  },
  {
    id: 'momentum',
    name: 'Momentum and risk',
    brief: 'Momentum and risk: candle size and speed, any indicators drawn on the chart (moving averages, RSI and so on — ignore what is not there), whether the move is stretched, a stop distance that fits the recent candle ranges, and whether the reward clearly covers the spread.',
  },
];

/**
 * Whether to analyse at all, decided before any usage is spent.
 *   closed      gold at the weekend
 *   stand-aside a scheduled release is inside its blackout
 *   stand-down  the weekday dead zone for this instrument (decision 2)
 *   caution     allowed, but outside the user's window or at the weekend
 *   ok          allowed
 */
export function shotGate({ pair, weekend, blackout, band, insideWindow, win }) {
  if (pair === 'XAUUSD' && weekend) {
    return { allowed: false, state: 'closed', message: 'Gold is closed at the weekend. There is nothing to trade.' };
  }
  if (blackout && blackout.active) {
    const clear = blackout.endsAtMs && win ? ` Clear at ${formatHM(blackout.endsAtMs, win.tz)}.` : '';
    return {
      allowed: false, state: 'stand-aside',
      message: `${blackout.event.name} ${blackout.phase === 'before' ? 'is about to be released' : 'has just been released'}. Stand aside.${clear}`,
    };
  }
  if (band === 'dead' && !weekend) {
    return {
      allowed: false, state: 'stand-down',
      message: 'These are the quiet hours for this instrument: the moves are too small for the costs, so it does not look for a trade.',
    };
  }
  if (weekend || !insideWindow) {
    return {
      allowed: true, state: 'caution',
      message: weekend
        ? 'Weekend: bitcoin trades, but liquidity is thin and your broker\'s spread can widen. Treat any idea with extra care.'
        : 'Outside your trading hours. Treat any idea with extra care.',
    };
  }
  return { allowed: true, state: 'ok', message: null };
}

/** The context every reader gets, as plain lines. Kept small: it is re-sent with every call. */
export function contextLines(c) {
  const lines = [
    `Instrument selected in the trader's tool: ${c.pair} (${c.pair === 'XAUUSD' ? 'gold, spot, quoted to 2 decimals' : 'bitcoin CFD, quoted to 2 decimals'}).`,
    'Intended chart: MetaTrader 5, M5 (five-minute candles). Chart prices are BID prices.',
    `Time now: ${c.nowText} London (${c.weekday}). Session: ${c.sessionName}.`,
    `Broker spread now: about ${c.spread} (${c.spreadSource}). Every trade pays it once.`,
    c.news.length
      ? `Scheduled releases in the next 90 minutes: ${c.news.join('; ')}.`
      : 'No scheduled releases in the next 90 minutes.',
  ];
  if (c.caution) lines.push(`Caution: ${c.caution}`);
  if (c.planSetups && c.planSetups.length) {
    lines.push(`The trader's plan today: setups ${c.planSetups.join(', ')}; ${c.tradesTaken} of ${c.maxTrades} planned trades taken.`);
  }
  if (c.priceNow > 0) lines.push(`The trader typed the current price from MT5 as ${c.priceNow}. Trust it over your own reading.`);
  return lines;
}

const ANALYST_JSON = '{"readable": true, "instrument_seen": "XAUUSD", "timeframe_seen": "M5", "price_now": 4391.2, "axis_low": 4380.0, "axis_high": 4402.0, "view": "buy", "entry": 4391.2, "stop_loss": 4386.5, "take_profit_1": 4398.0, "take_profit_2": 4401.5, "confidence": 0.55, "reasons": ["..."], "against": ["..."]}';

/** The prompt for one analyst. */
export function analystPrompt(lens, c) {
  return [
    `You are one of three independent analysts reading a screenshot of a MetaTrader 5 chart for a trader who scalps the five-minute chart. Your lens is ${lens.brief}`,
    '',
    'Context from the trader\'s tool (reliable):',
    ...contextLines(c).map((l) => `- ${l}`),
    '',
    'Work through it in this order:',
    `1. Check this is an MT5 chart of ${c.pair}. Read the timeframe label and the current price from the price tag on the right-hand axis. If you cannot read the price axis clearly, set "readable": false and stop there.`,
    '2. Read the lowest and highest price labels on the right-hand axis.',
    '3. Read the chart through your lens.',
    '4. Decide "buy", "sell" or "none". Choose "none" whenever the picture is unclear or mixed, price is in the middle of its range, or the reward does not clearly exceed the risk after the spread. "none" is a good answer, not a failure.',
    `5. For buy or sell, give an entry (the current price for a market order, or a better level for a limit order), a stop loss beyond the structure that would prove the idea wrong, and two take-profit levels at real levels you can see on the chart. The stop must be at least ${c.minStopText} from the entry. Read every level off the axis; do not invent levels you cannot see.`,
    '',
    'Reply with only one JSON object, like this:',
    ANALYST_JSON,
    'Prices are numbers, not strings. Use null for entry, stop_loss and both take-profits when "view" is "none". Keep "reasons" and "against" to at most three short plain-English items each.',
  ].join('\n');
}

const HEAD_JSON = '{"decision": "buy", "entry_type": "market", "entry": 4391.2, "stop_loss": 4386.5, "take_profit_1": 4398.0, "take_profit_2": 4401.5, "price_now": 4391.2, "confidence": "moderate", "summary": "One or two plain sentences.", "reasons": ["..."], "against": ["..."], "invalidated_if": "Price closes below 4386.5."}';

/** The prompt for the head trader, who sees the picture and all three readings. */
export function headPrompt(readings, c) {
  const shown = readings.map((r, i) => `Analyst ${i + 1} (${LENSES[i] ? LENSES[i].name : 'analyst'}): ${JSON.stringify(r)}`);
  return [
    'You are the head trader. Three analysts independently read the attached screenshot of a MetaTrader 5 chart for a five-minute scalper. Decide the final plan.',
    '',
    'Context from the trader\'s tool (reliable):',
    ...contextLines(c).map((l) => `- ${l}`),
    '',
    'Their readings:',
    ...shown,
    '',
    'Rules:',
    '- Look at the chart yourself and check every level they give against it.',
    '- If fewer than two analysts point the same way, or they read the current price differently, the answer is "no_trade" unless the chart plainly shows which of them is wrong — say why.',
    `- The stop loss sits beyond the structure that proves the idea wrong, and at least ${c.minStopText} from the entry.`,
    '- Take profit 1 must pay at least as much as the stop risks, after the spread. Take profit 2 is further, at the next real level.',
    '- Prefer "no_trade" to a marginal trade. Do not claim certainty: this is an idea from a picture.',
    '',
    'Reply with only one JSON object, like this:',
    HEAD_JSON,
    '"decision" is "buy", "sell" or "no_trade"; "entry_type" is "market" or "limit"; "confidence" is "low", "moderate" or "high". Prices are numbers; use null for every price when the decision is "no_trade". At most three reasons and three items against, in plain English.',
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
    `Check it is an MT5 chart of ${c.pair} and read the current price from the price tag on the right-hand axis. Read structure, levels and momentum. Choose "no_trade" whenever the picture is unclear or mixed, or the reward does not clearly exceed the risk after the spread. For a trade, the stop sits beyond the structure that proves it wrong and at least ${c.minStopText} from the entry, and take profit 1 pays at least the risk after the spread. Read every level off the axis.`,
    '',
    'Reply with only one JSON object, like this:',
    HEAD_JSON.replace('"invalidated_if"', '"axis_low": 4380.0, "axis_high": 4402.0, "invalidated_if"'),
    'Use null for every price when the decision is "no_trade".',
  ].join('\n');
}

const num = (x) => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x.replace(/,/g, '')) : NaN);
const round = (x, d) => +Number(x).toFixed(d);

export function median(xs) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/**
 * Turn the head trader's plan into what the page shows, applying the rules
 * the model is not trusted to enforce on itself. Anything that fails becomes
 * "no_trade" with the reason, so the user sees why rather than a number.
 *
 *   plan      the head trader's (or fast reader's) JSON
 *   readings  the analysts' JSON (empty in fast mode)
 *   ctx       { spread, digits, priceNow (typed, optional) }
 */
export function checkPlan(plan, readings = [], ctx = {}) {
  const { spread = 0, digits = 2, priceNow = null } = ctx;
  const problems = [];
  const good = readings.filter((r) => r && r.readable !== false);

  if (!plan || typeof plan !== 'object') return { decision: 'no_trade', problems: ['The analysis came back empty.'] };
  if (readings.length && good.length < 2) problems.push('Fewer than two analysts could read the chart. Retake the screenshot with the price scale showing.');

  // The current price: what the user typed wins; otherwise the analysts must agree.
  const reads = [...good.map((r) => num(r.price_now)), num(plan.price_now)].filter((x) => x > 0);
  const price = priceNow > 0 ? priceNow : median(reads);
  if (!(price > 0)) problems.push('The current price could not be read from the chart.');
  if (!(priceNow > 0) && reads.length >= 2) {
    const spreadOfReads = (Math.max(...reads) - Math.min(...reads)) / price;
    if (spreadOfReads > 0.0015) problems.push('The analysts read the current price differently. Retake the screenshot with the price tag showing, or type the price in.');
  }

  const decision = plan.decision === 'buy' || plan.decision === 'sell' ? plan.decision : 'no_trade';
  const base = { summary: typeof plan.summary === 'string' ? plan.summary : '', reasons: listOf(plan.reasons), against: listOf(plan.against), confidence: ['low', 'moderate', 'high'].includes(plan.confidence) ? plan.confidence : 'low', invalidatedIf: typeof plan.invalidated_if === 'string' ? plan.invalidated_if : '', priceNow: price > 0 ? round(price, digits) : null };

  // Agreement among analysts who could read the chart.
  const agree = good.filter((r) => r.view === decision).length;
  const agreement = readings.length ? { agree, of: good.length } : null;

  if (decision === 'no_trade') return { ...base, decision, problems, agreement };
  if (readings.length && agree < 2) problems.push(`Only ${agree} of ${good.length} analysts saw a ${decision}.`);

  const entry = num(plan.entry), sl = num(plan.stop_loss), tp1 = num(plan.take_profit_1), tp2 = num(plan.take_profit_2);
  if (![entry, sl, tp1].every((x) => Number.isFinite(x) && x > 0)) {
    problems.push('The plan is missing an entry, stop loss or take profit.');
    return { ...base, decision: 'no_trade', problems, agreement };
  }
  const buy = decision === 'buy';
  if (buy ? !(sl < entry && entry < tp1) : !(tp1 < entry && entry < sl)) problems.push('The stop loss or take profit is on the wrong side of the entry.');
  if (Number.isFinite(tp2) && tp2 > 0 && (buy ? tp2 < tp1 : tp2 > tp1)) problems.push('Take profit 2 is not beyond take profit 1.');

  const stopDist = Math.abs(entry - sl);
  if (spread > 0 && stopDist < 5 * spread) problems.push(`The stop is only ${(stopDist / spread).toFixed(1)}× the spread from the entry. Below 5× the costs eat the trade.`);
  const netR = (Math.abs(tp1 - entry) - spread) / (stopDist + spread);
  if (!(netR >= 1)) problems.push(`Take profit 1 pays ${Math.max(0, netR).toFixed(2)}× the risk after the spread. It needs at least 1×.`);
  if (price > 0 && Math.abs(entry - price) / price > 0.004) problems.push('The entry is too far from the current price for a five-minute trade.');

  // Levels must be ones the chart actually shows (with a little room for targets).
  const lows = [...good.map((r) => num(r.axis_low)), num(plan.axis_low)].filter((x) => x > 0);
  const highs = [...good.map((r) => num(r.axis_high)), num(plan.axis_high)].filter((x) => x > 0);
  const lo = median(lows), hi = median(highs);
  if (lo > 0 && hi > lo) {
    const room = (hi - lo) * 0.25;
    const outside = [sl, tp1].some((x) => x < lo - room || x > hi + room);
    if (outside) problems.push('A level is outside the part of the chart the screenshot shows.');
  }

  if (problems.length) return { ...base, decision: 'no_trade', problems, agreement, rejected: decision };
  return {
    ...base, decision, problems: [], agreement,
    entryType: plan.entry_type === 'limit' ? 'limit' : 'market',
    entry: round(entry, digits), stopLoss: round(sl, digits),
    takeProfit1: round(tp1, digits),
    takeProfit2: Number.isFinite(tp2) && tp2 > 0 ? round(tp2, digits) : null,
    stopDistance: round(stopDist, digits), netR: +netR.toFixed(2),
  };
}

function listOf(x) {
  return Array.isArray(x) ? x.filter((s) => typeof s === 'string' && s.trim()).slice(0, 3) : [];
}

/** Is a stored analysis still usable for a ticket? */
export function shotIsFresh(shot, nowMs, pair) {
  return !!shot && shot.pair === pair && (nowMs - shot.atMs) <= SHOT_MAX_AGE_MS
    && (shot.result.decision === 'buy' || shot.result.decision === 'sell');
}
