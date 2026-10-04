/**
 * desk/lib.mjs — the scalp desk, for use inside a Claude chat.
 *
 * Why this exists. The page in index.html cannot load live prices inside
 * claude.ai, and on the user's iPhone claude.ai would not let it attach a
 * picture either (decision 23). The user can, though, send MT5 screenshots
 * straight into a Claude Code session from the Claude app. So the same tool
 * runs here instead: the session reads the screenshot, and this file applies
 * the rules the reader is not trusted to apply to itself — the gate, the
 * checks on every plan, the lot size and the MT5 ticket.
 *
 * Nothing here is new logic. Every rule comes from src/ (shot.js, sessions.js,
 * news-calendar.js, risk.js, brief.js), the same functions the page runs, so
 * the chat and the page cannot disagree. What this file adds is the wording
 * for a chat reply, and the session-specific plumbing: where the uploaded
 * picture is on disk, and where a run's files live.
 *
 * Two deliberate differences from the page (HANDOFF decision 24). The ticket
 * is sized with the spread the analysis used — typed, or the confirmed usual
 * one — where the page uses 0 until a live spread is typed; leaving it out
 * would undercount the cost (decision 15). And a plain No trade shows its
 * reasons but not its "against" list, which is the case for a trade.
 *
 * Pure apart from latestUpload(), so it is tested under node without a page.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { formatHM, formatDuration, tzOffsetMs } from '../src/timezone.js';
import { INSTRUMENTS, spec, marginModel, marginPerLotFor, commissionRoundTurnQuote } from '../src/instruments.js';
import { sizeBothModels, mt5Ticket, orderSplit, fillRisk, marginPosture } from '../src/risk.js';
import { getUpcomingEvents, getActiveBlackout, brokerChartTime, dstMisalignment } from '../src/news-calendar.js';
import { DEFAULT_WINDOW, windowState, sessionQuality, remainingBands, insideWindow } from '../src/sessions.js';
import { dayKey, todaysPrints, dayShape, planStatus, whereInRange } from '../src/brief.js';
import { shotGate, marketOpenNow, stopFloor, SHOT_MAX_AGE_MS } from '../src/shot.js';
import { assessRecord, breakEvenRate, tradesNeeded, timeToSample } from '../src/edge-test.js';

/** What the desk assumes until the user says otherwise. Mirrors the page's defaults. */
export const DEFAULT_CONFIG = {
  account: {
    balance: 9816107.46, currency: 'GBP', riskPct: 1, gbpusd: 1.35, leverage: 500,
    shadowBalance: null, sizeFrom: 'account',
    // Null means "use the specification" (gold 2.75 GBP a lot each side, bitcoin none); 0 means zero.
    commissionPerSideGBP: null,
  },
  // 'auto': New York + 7, which is what the broker's gold break showed (its
  // 01:02 server reopen is 18:00 New York). UTC+3 now, UTC+2 from 1 November.
  broker: { serverOffset: 'auto', fillMode: 'ioc' },
  window: DEFAULT_WINDOW,
  mode: 'thorough',
  record: { trades: 0, wins: 0, rewardRisk: 1, perDay: 5, plannedSample: 0 },
};

/** A shallow-per-section merge, so a config file need only hold what differs. */
export function withDefaults(cfg = {}) {
  const out = {};
  for (const [k, v] of Object.entries(DEFAULT_CONFIG)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...v, ...(cfg[k] || {}) } : (cfg[k] ?? v);
  }
  return out;
}

/** "gold", "xau", "XAUUSD", "btc", "bitcoin" → the instrument id, or null. */
export function pairOf(s) {
  const t = String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (/XAU|GOLD/.test(t)) return 'XAUUSD';
  if (/BTC|XBT|BITCOIN/.test(t)) return 'BTCUSD';
  return null;
}

export const label = (pair) => INSTRUMENTS[pair].label;
export const digitsOf = (pair) => spec(INSTRUMENTS[pair], 'digits');

/** en-GB number with fixed decimals: 84,400.00. */
export function fmt(x, d = 2) {
  if (x === null || x === undefined || !Number.isFinite(Number(x))) return '—';
  return Number(x).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/* ----------------------------------------------------------------- clock */

/**
 * The MT5 server's UTC offset. A number in the config is used as it is;
 * 'auto' follows New York + 7. The only week that can disagree is 25 Oct –
 * 1 Nov 2026, when Europe has changed its clocks and New York has not: if the
 * broker follows Europe instead, it is UTC+2 that week. clockCheckLine() asks
 * the user to look.
 */
export function serverOffsetFor(nowMs, cfg) {
  const o = cfg.broker.serverOffset;
  if (o === 'auto' || o === null || o === undefined || o === '') {
    return Math.round(tzOffsetMs(nowMs, 'America/New_York') / 3600e3) + 7;
  }
  return Number(o);
}

/** In the week the two clock conventions disagree, one line asking the user to check MT5's clock. */
export function clockCheckLine(nowMs, cfg) {
  const d = dstMisalignment(nowMs);
  if (!d || !/Europe off DST/.test(d.note) || cfg.broker.serverOffset !== 'auto') return '';
  const chart = brokerChartTime(nowMs, serverOffsetFor(nowMs, cfg));
  return `Clocks-change week: does the clock on your MT5 chart read about **${chart.text}** right now? If it reads an hour earlier, tell me — the broker's daily breaks move by an hour.`;
}

/* ------------------------------------------------------------------ gate */

/** The same gate the page's screenshot card applies (app.js currentShotGate). */
export function gateFor(pair, nowMs, cfg) {
  const win = cfg.window;
  const inst = INSTRUMENTS[pair];
  const w = windowState(nowMs, win);
  const q = sessionQuality(nowMs, pair, win);
  const band = remainingBands(nowMs, pair, win).find((b) => b.current);
  const nextMajor = getUpcomingEvents(nowMs, 1, pair, { includeContext: false })
    .filter((e) => e.tier === 1 && e.ts > nowMs)[0] || null;
  return shotGate({
    pair, weekend: w.phase === 'weekend',
    blackout: getActiveBlackout(nowMs, pair, {}),
    band: q.band, insideWindow: w.open, win,
    marketOpen: marketOpenNow(inst, nowMs, serverOffsetFor(nowMs, cfg)),
    bandEndsAtMs: band ? band.endsAtMs : null, nextMajor, nowMs,
  });
}

/** The all-in cost of one trade as a price distance: spread plus commission over the contract. */
export function costFor(pair, spreadNum, cfg) {
  const inst = INSTRUMENTS[pair];
  const rt = commissionRoundTurnQuote(inst, cfg.account.gbpusd, cfg.account.commissionPerSideGBP) || 0;
  const comm = rt / spec(inst, 'contractSize');
  return { comm, cost: spreadNum + comm };
}

/**
 * Everything the readers are told, in the shape shot.js's prompts take — the
 * page's shotContext(), with the account settings coming from the config.
 */
export function contextFor({ nowMs, pair, gate, priceNow, spreadNum, spreadTyped, cfg, plan = null }) {
  const inst = INSTRUMENTS[pair];
  const digits = digitsOf(pair);
  const { comm, cost } = costFor(pair, spreadNum, cfg);
  const ps = planStatus(plan, dayKey(nowMs, cfg.window));
  const chart = brokerChartTime(nowMs, serverOffsetFor(nowMs, cfg));
  return {
    pair, digits, priceNow,
    nowText: formatHM(nowMs, 'Europe/London'),
    weekday: new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'Europe/London' }).format(nowMs),
    chartClock: chart ? chart.text : null,
    sessionName: sessionQuality(nowMs, pair, cfg.window).name,
    spread: spreadNum.toFixed(digits), spreadNum,
    spreadSource: spreadTyped ? 'typed in by the trader' : "last read off the trader's MT5",
    commission: comm > 0 ? comm.toFixed(3) : 0, cost: cost.toFixed(3), costNum: cost,
    stopFloor: stopFloor(cost, priceNow, inst.minStopPct).toFixed(digits),
    news: getUpcomingEvents(nowMs, 1.5, pair, { includeContext: false })
      .filter((e) => e.ts > nowMs).map((e) => `${e.short || e.name} at ${formatHM(e.ts, 'Europe/London')} London`),
    caution: gate.state === 'caution' ? gate.message : null,
    planSetups: ps ? ps.setups : [], tradesTaken: ps ? ps.taken : 0, maxTrades: ps ? ps.max : 0,
    lastStretch: windowState(nowMs, cfg.window).phase === 'last-30',
  };
}

/* ------------------------------------------------------------- wording */

/**
 * shot.js's messages were written for the page ("the instrument selected at
 * the top", "this page"). The rules are the same here; only the words that
 * point at the page change.
 */
export function forChat(text) {
  return String(text)
    .replace('the instrument selected at the top', 'the instrument you named')
    .replace('This page builds market orders only', 'The desk builds market orders only')
    .replace('Switch to Bitcoin, or come back on Monday', 'Bitcoin is still open, or come back on Monday')
    .replace('type today\'s spread before you analyse', 'send me today\'s spread from MT5')
    .replace('type the spread from MT5 before you analyse', 'send me the spread from MT5')
    .replace('Type the spread as it is right now', 'Send the spread as it is right now');
}

/** A gate's caution, once the spread is in: the warning stays, the request to send it goes. */
export function cautionAfter(text) {
  return String(text)
    .replace(/ — type today's spread before you analyse\./, '.')
    .replace(/ — type the spread from MT5 before you analyse\./, '.')
    .replace(/ ?Type the spread as it is right now\./, '')
    .trim();
}

/**
 * Where the user is in the day, in the coarse words the page uses — never a
 * time to the close (decision 1).
 */
export function phaseWords(nowMs, pair, win) {
  const w = windowState(nowMs, win);
  if (w.phase === 'weekend') return 'Weekend — markets closed or thin';
  if (w.phase === 'before') return 'Before your window opens';
  if (w.phase === 'after') return 'Your window has closed';
  if (w.phase === 'last-30') return 'Final stretch — confidence is marked down';
  return sessionQuality(nowMs, pair, win).name;
}

/** The next tier-1 or tier-2 release within `hours`, as one line, or ''. A countdown to news is allowed; one to the close is not. */
export function nextNewsLine(nowMs, pair, win, hours = 2) {
  const e = getUpcomingEvents(nowMs, hours, pair, { includeContext: false })
    .filter((x) => x.ts > nowMs && x.tier <= 2)[0];
  return e ? `Next news: **${e.short || e.name}** at ${formatHM(e.ts, win.tz)} London (in ${formatDuration(e.ts - nowMs)}).` : '';
}

/** The headline for a gate that stops the analysis. */
export function gateWord(gate) {
  return gate.state === 'stand-aside' ? 'Stand aside' : gate.state === 'closed' ? 'Closed' : gate.state === 'stand-down' ? 'Stand down' : '';
}

/** The whole reply when the gate says no: no reading, no direction, no levels. */
export function formatBlocked(pair, gate) {
  return [
    `**■ ${gateWord(gate)} · ${label(pair)}**`,
    forChat(gate.message),
    'No screenshot is read now, so there is no idea to give.',
  ].join('\n\n');
}

/* ---------------------------------------------------------------- sizing */

/**
 * Lot size and the MT5 ticket, as the page's Size tab works them out. The
 * stop loss on the ticket sits at the distance the volume was sized from: a
 * typed stop moves it, otherwise it is the analysis's own.
 */
export function sizeFor({ pair, cfg, stop, entry, spreadNum = 0, side = null, stopLoss = null, target = null, typedStop = false }) {
  const inst = INSTRUMENTS[pair];
  const a = cfg.account;
  const usingShadow = a.sizeFrom === 'shadow' && a.shadowBalance > 0;
  const bal = usingShadow ? a.shadowBalance : a.balance;
  const fx = a.currency === 'USD' ? 1 : a.gbpusd;
  const mm = marginModel(inst, a.leverage);
  const contract = spec(inst, 'contractSize');
  const commission = commissionRoundTurnQuote(inst, a.gbpusd, a.commissionPerSideGBP) || 0;
  const digits = digitsOf(pair);
  const r = sizeBothModels({
    equity: bal, riskPercent: a.riskPct, stopDistance: stop, price: entry,
    pointSize: 0.10, contractSize: contract, marginFactor: mm.factor, fxRate: fx,
    accountCurrency: a.currency, spread: spreadNum, commissionPerLotRoundTurn: commission,
    lotStep: spec(inst, 'lotStep'), minLot: spec(inst, 'minLot'),
  });
  // The idea's own stop loss stays exactly as checked; only a stop the user
  // typed moves it (to the distance the volume was sized from).
  const slLevel = side && typedStop && stop > 0 ? (side === 'buy' ? entry - stop : entry + stop) : stopLoss;
  const tk = side && slLevel ? mt5Ticket({ side, entry, invalidation: slLevel, target, lots: r.ok ? r.cfd.lots : 0, digits }) : null;
  const lots = tk ? tk.volume : r.ok ? r.cfd.lots : 0;
  const split = lots > 0 ? orderSplit(lots, spec(inst, 'maxVolume') || 0) : null;
  const fill = lots > 0 ? fillRisk({ lots, contractSize: contract, fillMode: cfg.broker.fillMode }) : null;
  const mpl = marginPerLotFor(inst, contract, a.leverage, entry);
  const posture = r.ok ? marginPosture({
    marginPct: r.margin.pctOfEquity / 100, leverage: mm.equivLeverage, equity: bal,
    marginPerLotAccount: mpl ? mpl.amount / fx : null, wantedLots: r.cfd.lots,
  }) : null;
  return { r, tk, split, fill, posture, usingShadow, bal, digits };
}

/** The warnings that follow a lot size: margin, order splitting, partial fills. */
function sizeWarnings({ split, fill, posture }) {
  const out = [];
  if (posture && posture.state === 'binding') out.push(`⚠ ${posture.headline}: this position takes most of the account in margin.`);
  if (split && split.needsSplit) {
    const full = split.remainder ? split.orders - 1 : split.orders;
    out.push(`⚠ Too big for one order. Place ${full} × ${split.perOrder} lots${split.remainder ? ` and 1 × ${Number(split.remainder).toFixed(2)}` : ''}, each with the same stop loss and take profit.${split.orders > 5 ? ` That is ${split.orders} orders — too many to place by hand. Tell me a shadow balance (what you would trade live) and I will size from that instead.` : ''}`);
  }
  if (fill && fill.large) out.push('At this size you may only get part of the order filled.');
  return out;
}

const riskLine = (s, cfg) =>
  `Risking ${cfg.account.currency} ${fmt(s.r.cfd.actualRisk, 2)} · ${cfg.account.riskPct}%${s.usingShadow ? ' of your shadow balance' : ' of the account'}.`;

/** The ticket lines of a reply. */
export function ticketLines(s, pair, cfg) {
  const { r, tk, digits } = s;
  if (!r.ok) return [`Could not size it: ${r.blocked.join('; ')}.`];
  if (!(r.cfd.lots > 0)) return [`${r.cfd.note || 'Below the minimum lot.'} The stop is too wide for this balance and risk %, so there is no ticket.`];
  if (!tk) return ['Could not build a ticket: no stop loss.'];
  const out = [
    `**MT5 ticket — ${tk.side.toUpperCase()} ${pair}**`,
    `- Volume **${tk.volume.toFixed(2)}** lots`,
    `- Stop loss **${fmt(tk.stopLoss, digits)}**`,
  ];
  if (tk.takeProfit !== null) out.push(`- Take profit **${fmt(tk.takeProfit, digits)}**`);
  out.push(riskLine(s, cfg), ...sizeWarnings(s));
  return out;
}

/** A lot size for a stop distance the user typed, with no idea to attach it to. */
export function lotsOnlyLines(s, stop, cfg, pair) {
  const { r, digits } = s;
  if (!r.ok) return [`Could not size it: ${r.blocked.join('; ')}.`];
  if (!(r.cfd.lots > 0)) return [`${label(pair)}: a ${fmt(stop, digits)} stop comes to less than the minimum lot for this balance and risk %.`];
  return [
    `${label(pair)}: volume for your ${fmt(stop, digits)} stop is **${r.cfd.lots.toFixed(2)} lots**.`,
    riskLine(s, cfg),
    ...sizeWarnings(s),
    'Take the stop loss and take profit from your MT5 chart.',
  ];
}

/* ---------------------------------------------------------------- replies */

/**
 * The reply for a checked plan. A rejected idea shows only the reasons it
 * failed — never its direction, summary or levels (decision 22).
 */
export function formatIdea({ result, pair, ctx, cfg, mode, atMs, nowMs, sized = null, readings = [] }) {
  const r = result;
  const digits = ctx.digits;
  const trade = r.decision === 'buy' || r.decision === 'sell';
  const head = r.decision === 'buy' ? '▲ Buy idea' : r.decision === 'sell' ? '▼ Sell idea' : '■ No trade';
  const how = mode === 'thorough' ? 'Thorough' : 'Fast';
  const ag = r.agreement ? `, ${r.agreement.agree} of ${r.agreement.asked} readings agree${r.agreement.asked > r.agreement.of ? ` (${r.agreement.asked - r.agreement.of} could not read it)` : ''}` : '';
  const out = [`**${head} · ${label(pair)}**`];
  if (ctx.caution && trade) out.push(`⚠ ${cautionAfter(ctx.caution)}`);
  if (nowMs - atMs > SHOT_MAX_AGE_MS) out.push('⚠ This analysis is over 15 minutes old. Send a new screenshot before trading on it.');

  if (trade) {
    out.push([
      `Market order at **${fmt(r.entry, digits)}** (your price) · ${how}${ag}`,
      '',
      `- Stop loss **${fmt(r.stopLoss, digits)}**`,
      `- Take profit 1 **${fmt(r.takeProfit1, digits)}** (on the ticket)`,
      ...(r.takeProfit2 ? [`- Take profit 2 ${fmt(r.takeProfit2, digits)} (not on the ticket — the next level, if you later move your target by hand)`] : []),
    ].join('\n'));
    out.push(`Pays ${r.netR}× the risk at take profit 1, after spread and commission. Readers' confidence: **${r.confidence}**.${ctx.lastStretch ? ' Final stretch — confidence is marked down.' : ''}`);
    if (r.summary) out.push(r.summary);
    if (sized) out.push(ticketLines(sized, pair, cfg).join('\n'));
    const why = [];
    if (r.reasons.length) why.push(`**For it:** ${r.reasons.join('; ')}.`);
    if (r.against.length) why.push(`**Against it:** ${r.against.join('; ')}.`);
    if (r.invalidatedIf) why.push(`**Wrong if:** ${r.invalidatedIf}`);
    if (why.length) out.push(why.join('\n'));
    out.push(`_Read from your screenshot at ${formatHM(atMs, cfg.window.tz)} London (${how}). Levels can be a little off: check them on your MT5 chart before you enter. If MT5's price is now more than ${fmt(r.stopDistance / 4, digits)} from ${fmt(r.entry, digits)}, send a new screenshot — the risk would no longer match. It has no track record, and the decision is yours._`);
  } else if (r.rejected) {
    out.push(`An idea was suggested, but it failed these checks (${how}${ag}):\n${r.problems.map((p) => `- ${forChat(p)}`).join('\n')}`);
  } else {
    // A plain No trade gives its reasons, not its "against" list: against a
    // no-trade is the case FOR a trade, and in a chat nothing sits behind a
    // tap the way the page's Why? does. A direction on screen gets traded.
    if (r.summary) out.push(r.summary);
    if (r.reasons.length) out.push(r.reasons.map((x) => `- ${x}`).join('\n'));
    const seen = readings.filter((x) => x && x.readable !== false);
    const none = seen.filter((x) => x.view === 'none').length;
    out.push(`_${how}${r.agreement ? ` · ${none} of ${r.agreement.asked} readers saw no trade${r.agreement.asked > seen.length ? ` (${r.agreement.asked - seen.length} could not read it)` : ''}` : ''}._`);
  }
  return out.join('\n\n');
}

/** "Plan: 2 of 5 trades" for today, or ''. */
export function planLine(plan, nowMs, win) {
  const ps = planStatus(plan, dayKey(nowMs, win));
  if (!ps) return '';
  return `Plan: ${ps.text}${ps.atLimit ? ' — that is the number you planned this morning' : ps.over ? ' — past the number you planned this morning' : ''}.`;
}

/** Where the day is, for both instruments. */
export function formatNow(nowMs, cfg, plan) {
  const win = cfg.window;
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: win.tz }).format(nowMs);
  const out = [`**${formatHM(nowMs, win.tz)} London, ${day}** · ${phaseWords(nowMs, 'XAUUSD', win)}`];
  const rows = [];
  for (const pair of ['XAUUSD', 'BTCUSD']) {
    const g = gateFor(pair, nowMs, cfg);
    const word = g.allowed ? (g.state === 'caution' ? 'open, with a warning' : 'open') : gateWord(g);
    rows.push(`- ${label(pair)}: **${word}**${g.message ? ` — ${forChat(g.message)}` : ''}`);
  }
  out.push(rows.join('\n'));
  const news = nextNewsLine(nowMs, null, win, 24);
  if (news) out.push(news);
  const pl = planLine(plan, nowMs, win);
  if (pl) out.push(pl);
  const clock = clockCheckLine(nowMs, cfg);
  if (clock) out.push(clock);
  return out.join('\n\n');
}

/** The pre-session brief, for one instrument or both. `range` is the user's own overnight high/low/now. */
export function formatBrief(nowMs, cfg, plan, pairs = ['XAUUSD', 'BTCUSD'], range = null) {
  const win = cfg.window;
  const tz = win.tz;
  const w = windowState(nowMs, win);
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: tz }).format(nowMs);
  const title = w.phase === 'before' ? 'Before the open' : w.open ? 'The rest of today' : w.phase === 'weekend' ? 'Weekend' : 'After the close';
  const out = [`**${title} — ${day}**`];
  if (w.phase === 'weekend') out.push('Gold is closed. Bitcoin trades, but liquidity is thin and the spread can widen — send the spread with any bitcoin screenshot.');
  const span = (x) => `${formatHM(x.fromMs, tz)}–${formatHM(x.toMs, tz)}`;
  for (const pair of w.phase === 'weekend' ? [] : pairs) {
    const lines = [`**${label(pair)}**`];
    const prints = todaysPrints(nowMs, pair, win);
    lines.push(prints.length
      ? prints.map((e) => `- ${formatHM(e.ts, tz)} **${e.short || e.name}** (tier ${e.tier}) · be flat ${formatHM(e.flatFromMs, tz)}–${formatHM(e.flatToMs, tz)}`).join('\n')
      : '- Nothing scheduled in your window.');
    const shape = dayShape(nowMs, pair, win);
    for (const x of shape.sitOut) lines.push(`- Sit out ${span(x)} · ${x.names.join(', ').toLowerCase()}${pair === 'BTCUSD' ? ' (advice only: bitcoin screenshots are read at any hour)' : ''}`);
    for (const x of shape.best) lines.push(`- Best ${span(x)}`);
    if (range && range.pair === pair && range.high > range.low && range.now > 0) {
      const wr = whereInRange(range.now, range.high, range.low);
      lines.push(`- Overnight ${fmt(range.low, digitsOf(pair))}–${fmt(range.high, digitsOf(pair))}: price is ${wr.where}.`);
    }
    out.push(lines.join('\n'));
  }
  const dst = dstMisalignment(nowMs);
  if (dst) out.push(`⚠ ${dst.message}`);
  const clock = clockCheckLine(nowMs, cfg);
  if (clock) out.push(clock);
  const pl = planLine(plan, nowMs, win);
  out.push(pl || (w.phase === 'before' || w.open
    ? 'No plan yet for today. Tell me which setups you will take (trend pullback, breakout, range fade, sweep and reclaim, or your own) and the most trades you will take, and I will keep the count.'
    : ''));
  return out.filter(Boolean).join('\n\n');
}

/** Scheduled releases over the next few days, split by whether they land in the window. */
export function formatNews(nowMs, cfg, pair = null, days = 7) {
  const win = cfg.window;
  const rows = getUpcomingEvents(nowMs, 24 * days, pair, { includeContext: false })
    .filter((e) => e.ts > nowMs && typeof e.tier === 'number');
  const when = (ts) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: win.tz }).format(ts);
  const line = (e) => `- ${when(e.ts)} · **${e.short || e.name}** (tier ${e.tier}${e.affects !== 'both' ? `, ${label(e.affects).toLowerCase()} only` : ''}) · flat ${e.blackoutBefore}m before, ${e.blackoutAfter}m after${e.confidence !== 'verified' ? ' · unconfirmed' : ''}`;
  const inside = rows.filter((e) => insideWindow(e.ts, win) && e.tier <= 2);
  const out = [`**Scheduled news, next ${days} days${pair ? ` — ${label(pair)}` : ''}** (London time)`];
  out.push(inside.length ? `While you are trading:\n${inside.slice(0, 20).map(line).join('\n')}` : 'Nothing tier 1 or 2 lands inside your window.');
  const dst = dstMisalignment(nowMs);
  if (dst) out.push(`⚠ ${dst.message}`);
  out.push('_Dates were gathered from search results, not read off the agencies: check the tier-1 rows against your broker\'s calendar._');
  return out.join('\n\n');
}

/**
 * "Is it working yet?" — the page's edge test, worded for a chat. No verdict
 * before the sample the user committed to (decision 8).
 */
export function formatEdge(rec, costInRisk = 0) {
  const rr = rec.rewardRisk > 0 ? rec.rewardRisk : 1;
  const perDay = rec.perDay > 0 ? rec.perDay : 5;
  const costNote = costInRisk > 0 ? '' : ' Costs are not counted yet: tell me a typical stop distance and they will be.';
  if (!(rec.trades > 0)) {
    const be = breakEvenRate(rr, costInRisk);
    const need = be ? tradesNeeded(be + 0.05, be) : null;
    const t = need ? timeToSample(need, perDay) : null;
    return [
      '**Is it working yet?**',
      `No trades logged. At ${rr}:1${costInRisk > 0 ? ' with your costs' : ''}, break-even is **${be ? (be * 100).toFixed(1) : '—'}%**, not 50%.${t ? ` Proving a five-point edge over that takes roughly **${need} trades**, about ${t.months} months at ${perDay} a day.` : ''}${costNote}`,
      rec.plannedSample > 0 ? `Committed sample: ${rec.plannedSample} trades.` : 'Before your first trade, decide how many trades you will judge it on. Once that is set, there is no verdict until you reach it.',
    ].join('\n\n');
  }
  const r = assessRecord({ trades: rec.trades, wins: rec.wins, rewardRisk: rr, costInRisk, plannedSample: rec.plannedSample || 0 });
  if (!r) return 'Winners cannot be more than trades.';
  if (r.impossible) return r.reason;
  const head = r.verdict === 'edge' ? 'Evidence of an edge' : r.verdict === 'negative' ? 'Evidence against it'
    : r.verdict === 'collecting' ? `Collecting — ${r.pctDone}% of the way` : 'Not enough trades to say';
  return [
    `**Is it working yet? ${head}**`,
    [
      `- Observed ${(r.observedRate * 100).toFixed(1)}% over ${rec.trades} trades`,
      `- Break-even after costs ${(r.breakEven * 100).toFixed(1)}%`,
      `- True rate somewhere in ${(r.ci[0] * 100).toFixed(0)}–${(r.ci[1] * 100).toFixed(0)}%`,
      `- Expectancy ${r.expectancyR > 0 ? '+' : ''}${r.expectancyR.toFixed(3)}R ± ${(1.96 * r.expectancySe).toFixed(3)}`,
    ].join('\n'),
    r.text + costNote,
  ].join('\n\n');
}

/* ---------------------------------------------------------- the picture */

const IMAGE_RE = /\.(jpe?g|png|webp|gif)$/i;

/**
 * Pictures the Claude app uploaded into this container within `maxAgeMs`,
 * newest first. Uploads land under ~/.claude/uploads/<session>/; a reader
 * subagent cannot see the chat, so a path is how it sees the chart.
 */
export function recentUploads(root, nowMs, maxAgeMs = 15 * 60000) {
  const out = [];
  let dirs = [];
  try { dirs = readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    let files = [];
    try { files = readdirSync(join(root, d)); } catch { continue; }
    for (const f of files) {
      if (!IMAGE_RE.test(f)) continue;
      const p = join(root, d, f);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (!st.isFile() || nowMs - st.mtimeMs > maxAgeMs) continue;
      out.push({ path: p, ageMs: Math.max(0, nowMs - st.mtimeMs), mtimeMs: st.mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** The newest recent picture, or null. */
export function latestUpload(root, nowMs, maxAgeMs = 15 * 60000) {
  return recentUploads(root, nowMs, maxAgeMs)[0] || null;
}
