/* ===========================================================================
   app.js — wiring. Everything it renders comes from the modules above.
   =========================================================================== */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---- persistence: per-viewer convenience only, never load-bearing ------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem('msd.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('msd.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const state = {
  pair: store.get('pair', 'XAUUSD'),
  tab: 'read',
  mode: store.get('mode', 'live'),
  keys: store.get('keys', {}),
  serverOffset: store.get('serverOffset', 3),
  overrides: store.get('overrides', {}),
  bars: [],
  sample: true,
  feed: null,
  spread: store.get('spread', {}),
  window: store.get('window', DEFAULT_WINDOW),
  lastAnalysis: null,
};

/* ---- a plausible sample series so the page opens showing what it does --- */
function sampleBars(pair) {
  const base = pair === 'BTCUSD' ? 81000 : 4391;
  const scale = pair === 'BTCUSD' ? 140 : 3.4;
  const n = 260;
  const now = Date.now();
  const t0 = Math.floor((now - n * 300000) / 300000) * 300000;
  const out = [];
  let p = base - scale * 9;
  for (let i = 0; i < n; i++) {
    // A deterministic wander: drift, a session-scale swing, and bar noise.
    const drift = scale * 0.055;
    const swing = Math.sin(i / 17) * scale * 2.6 + Math.sin(i / 5.5) * scale * 0.8;
    const noise = Math.sin(i * 2.399) * scale * 0.45;
    const c = base - scale * 9 + drift * i + swing + noise;
    const o = p;
    const h = Math.max(o, c) + Math.abs(Math.sin(i * 1.7)) * scale * 0.5;
    const l = Math.min(o, c) - Math.abs(Math.cos(i * 1.31)) * scale * 0.5;
    out.push({ t: t0 + i * 300000, o, h, l, c, v: 800 + Math.abs(Math.sin(i / 3)) * 900 });
    p = c;
  }
  return out;
}

const zoneLabel = () => state.window.tz.split('/').pop().replace('_', ' ');
const inst = () => INSTRUMENTS[state.pair];
const dp = () => inst().decimalsForDisplay;
const fmt = (x, d) => (x === null || x === undefined || Number.isNaN(x) ? '—'
  : Number(x).toLocaleString('en-GB', { minimumFractionDigits: d ?? dp(), maximumFractionDigits: d ?? dp() }));

/* ======================================================= clocks & header */

function renderClock() {
  const now = Date.now();
  const win = state.window;
  // The window's own clock leads, because that is the one the user is on.
  $('clock-utc').textContent = formatHM(now, win.tz);
  const parts = [`${formatHM(now, 'UTC')} UTC`];
  if (state.serverOffset !== null && state.serverOffset !== '') {
    const b = brokerChartTime(now, Number(state.serverOffset));
    if (b) parts.push(`${b.text} chart`);
  }
  $('clock-sub').textContent = parts.join(' · ');
  renderSessionStrip(now);
}

/**
 * Where you are in the session — as a COARSE PHASE, deliberately not a countdown.
 *
 * This used to be a progress bar and a "15 minutes left" counter, and that was
 * a mistake worth documenting rather than quietly deleting.
 *
 * Salient end-of-period temporal landmarks causally INCREASE financial
 * risk-taking, via optimism rather than loss-chasing — which means the effect
 * is reference-independent and fires on winning days too, not just when
 * someone is down and trying to get back (Shah & Li 2025, Journal of Marketing
 * Research, across five million real investment decisions; McKenzie et al.
 * 2016, Journal of Behavioral Decision Making).
 *
 * A ticking clock toward 16:00 is precisely that landmark. Rendering it made
 * the tool an active participant in the behaviour it is supposed to help
 * against. So: coarse words, no numeric countdown, no progress bar, and no
 * colour ramping toward the close. Where the last hour needs handling, the
 * tool changes its own behaviour rather than telling the user to be careful.
 */
function renderSessionStrip(now) {
  const w = windowState(now, state.window);
  const el = $('sess-strip');
  const say = (text, tone = 'label-3') =>
    `<span style="color:var(--${tone})">${text}</span>`;

  switch (w.phase) {
    case 'weekend':
      el.innerHTML = say('Weekend — markets closed or thin');
      break;
    case 'before':
      el.innerHTML = say('Before the open');
      break;
    case 'after':
      el.innerHTML = say('Your window has closed');
      break;
    case 'opening':
      el.innerHTML = say('Session open');
      break;
    case 'closing':
      el.innerHTML = say('Into the final hour');
      break;
    case 'last-30':
      el.innerHTML = say('Final stretch', 'warn');
      break;
    default:
      el.innerHTML = say('Session open');
  }
}

/* =============================================================== session */

/**
 * The first card on the screen, because for someone who trades one fixed
 * window a day the most useful thing is not a snapshot of one bar — it is what
 * the rest of the window looks like.
 */
function renderFeed() {
  const dot = $('feed-dot'), txt = $('feed-text');
  if (state.sample) {
    dot.className = 'dot stale';
    txt.textContent = 'Sample data — not live. Connect a feed or type your own bars in Setup.';
  } else if (state.feed && state.feed.ok) {
    const ageMin = Math.round((Date.now() - state.bars[state.bars.length - 1].t) / 60000);
    const stale = ageMin > 12;
    dot.className = 'dot ' + (stale ? 'stale' : 'live');
    txt.textContent = `${state.feed.source.label} · ${state.bars.length} bars · last ${ageMin}m ago`
      + (state.feed.source.proxy ? ' · PROXY, not gold' : '');
  } else if (state.mode === 'manual') {
    dot.className = 'dot live';
    txt.textContent = `Your own bars · ${state.bars.length} read from MT5`;
  } else {
    dot.className = 'dot off';
    txt.textContent = 'No feed. Everything except price still works.';
  }
}

/* ============================================================== the read */

function renderRead(a) {
  const el = $('readout');

  // A substituted instrument must be impossible to miss. PAXG is a token, not
  // spot gold, and it diverges from spot exactly on short timeframes. Burying
  // that in a tooltip would be the single most misleading thing this tool
  // could do, so it gets a banner above the price.
  let banner = '';
  if (state.feed && state.feed.ok && state.feed.source.proxy) {
    banner = `<div class="unconfirmed" style="color:var(--danger);background:var(--danger-dim);margin:0 0 13px">
      <b>This is ${esc(state.feed.source.instrument)}.</b> ${esc(state.feed.source.note)}</div>`;
  } else if (state.sample) {
    banner = `<div class="unconfirmed" style="margin:0 0 13px">
      <b>Sample data.</b> These are generated bars so you can see how the tool reads a chart.
      Nothing here is a real price. Connect a feed or type your own bars under Setup.</div>`;
  } else if (state.feed && state.feed.ok && state.feed.source.instrument) {
    banner = `<div style="font-size:11.5px;color:var(--label-3);margin:0 0 11px">
      ${esc(state.feed.source.instrument)} · not your broker's price. Take entries, stops and targets from MT5.</div>`;
  }

  if (!a.ok) {
    el.innerHTML = banner + `<div class="bias-line"><span class="bias flat">${esc(a.headline)}</span></div>
      <p class="statement">${esc(a.detail)}</p>`;
    return;
  }

  if (a.state === 'stand-down') {
    el.innerHTML = banner + `
      <div class="bias-line"><span class="arrow flat">&#9644;</span>
        <span class="bias flat" style="font-size:22px">Stand down</span></div>
      <div class="price-big" style="font-size:26px;color:var(--label-2)">${fmt(a.price)}</div>
      <p class="statement"><b style="color:var(--label)">${esc(a.headline)}.</b> ${esc(a.detail)}</p>
      <div class="hr"></div>
      <p style="font-size:13px;color:var(--label-2);margin:0">
        The read is withheld rather than shown weakly — a direction on the screen gets traded, and
        in these hours the spread takes it back. Technicals read
        <b>${esc(a.technicalBiasSuppressed)}</b> at ${Math.round((a.suppressedConfidence || 0) * 100)}%,
        shown so you know what is being set aside.</p>`;
    return;
  }

  const dir = a.bias === 'long' ? 'up' : a.bias === 'short' ? 'down' : 'flat';
  const arrow = a.bias === 'long' ? '&#9650;' : a.bias === 'short' ? '&#9660;' : '&#9644;';
  const word = a.bias === 'long' ? 'Upward lean' : a.bias === 'short' ? 'Downward lean' : 'No lean';
  const pct = Math.round((a.confidence || 0) * 100);

  let html = banner + `
    <div class="bias-line">
      <span class="arrow ${dir}">${arrow}</span>
      <span class="bias ${dir}">${word}</span>
    </div>
    <div class="price-big">${fmt(a.price)}</div>
    <p class="statement">${esc(a.statement)}</p>`;

  // 'none' is the blackout state and carries no targets or weights; only a
  // real directional read has those. Checking for 'neutral' alone let the
  // blackout object fall into this branch and blow up on a.targets.
  if (a.bias === 'long' || a.bias === 'short') {
    html += `
      <div class="conf-wrap">
        <div class="conf-head"><span>Confidence · ${esc(a.confidenceLabel)}</span><span class="num">${pct}%</span></div>
        <div class="conf-track"><div class="conf-fill" style="width:${pct}%;background:var(--${dir === 'flat' ? 'flat' : dir})"></div></div>
      </div>
      <div class="hr"></div>
      <div class="row"><dt>Wrong ${a.bias === 'long' ? 'below' : 'above'}</dt><dd class="${dir}">${fmt(a.invalidation)}</dd></div>
      <div class="row"><dt>Stop distance</dt><dd>${fmt(a.stopDistance)}</dd></div>`;

    for (const t of a.targets.slice(0, 2)) {
      html += `<div class="row"><dt>Target · ${esc(t.basis)}</dt><dd>${fmt(t.price)}${t.r !== null ? ` <span style="color:var(--label-3)">${t.r}R</span>` : ''}</dd></div>`;
    }
    if (a.breakEven && !a.breakEven.impossible) {
      const hard = a.breakEven.rate > 55;
      html += `<div class="row"><dt>Win rate needed to break even</dt><dd style="color:var(--${hard ? 'warn' : 'label'})">${a.breakEven.rate}%</dd></div>`;
    }
    html += `<details class="more"><summary>How that invalidation was chosen</summary>
      <p style="font-size:13px;color:var(--label-2);margin:6px 0 0">${esc(a.invalidationBasis)}</p></details>`;
  }
  el.innerHTML = html;
}

/* =============================================================== session */

function renderSessionCard(now) {
  const w = windowState(now, state.window);
  const q = sessionQuality(now, state.pair, state.window);
  const bands = remainingBands(now, state.pair, state.window);
  const el = $('session-card');

  const head = (title, sub, tone = 'label') =>
    `<div style="margin-bottom:11px">
       <div style="font-size:19px;font-weight:700;letter-spacing:-.02em;color:var(--${tone})">${esc(title)}</div>
       <p style="font-size:13.5px;color:var(--label-2);margin:4px 0 0">${sub}</p>
     </div>`;

  let html = '';

  if (w.phase === 'weekend') {
    html = head('Weekend', esc(q.note), 'label-3');
  } else if (w.phase === 'before') {
    const next = bands[0];
    html = head('Before the open',
      next ? `First up when it starts: <b>${esc(next.name)}</b>. ${esc(next.note)}` : 'Window not started.');
  } else if (w.phase === 'after') {
    html = head('Window closed', 'Outside the hours you trade. The tool still reads the chart, but nothing here is aimed at a position you would open now.', 'label-3');
  } else if (w.phase === 'last-30') {
    // Deliberately NOT a countdown. The confidence bar is raised instead, and
    // the reason is stated once as arithmetic rather than as advice.
    html = head('Final stretch',
      'The threshold for a read has been raised for the rest of the session. A position opened now has to work inside the time left, which is a constraint the chart knows nothing about — and the approach of a deadline measurably increases risk-taking, on good days as much as bad ones.',
      'warn');
  } else {
    html = head(esc(q.name), esc(q.note),
      q.band === 'green' ? 'up' : q.band === 'amber' ? 'warn' : 'danger');
  }

  if (w.open || w.phase === 'before') {
    html += `<div class="hr"></div><p class="card-title">The rest of your window</p>`;
    for (const b of bands) {
      const from = formatHM(b.startsAtMs, state.window.tz);
      const to = formatHM(b.endsAtMs, state.window.tz);
      html += `<div class="plan${b.current ? ' now' : ''}">
        <div class="plan-time">${from}<br>${to}</div>
        <div class="plan-stripe g-${b.band}"></div>
        <div>
          <div class="plan-name">${esc(b.name)}${b.current ? ' · now' : ''}</div>
          <div class="plan-note">${esc(b.note)}</div>
        </div>
      </div>`;
    }
    if (!bands.length) html += '<p style="font-size:13px;color:var(--label-2);margin:0">Nothing left in the window today.</p>';
  }

  // Which of the two is worth watching right now.
  const pref = preferredInstrument(now, state.window);
  if (pref.pair && w.open) {
    const mismatch = pref.confident && pref.pair !== state.pair;
    html += `<div class="hr"></div>
      <div class="unconfirmed" style="${mismatch ? '' : 'color:var(--label-2);background:var(--surface-3)'}">
        <b>${pref.confident ? `${esc(INSTRUMENTS[pref.pair].label)} is the better of your two right now.` : 'Both are live from here.'}</b>
        ${esc(pref.reason)}
        ${mismatch ? `<br><br>You are looking at ${esc(inst().label)}.` : ''}
      </div>`;
  }

  // Events still to come inside the window — the ones that will actually reach him.
  const evs = getUpcomingEvents(now, 12, state.pair, { includeContext: false })
    .filter((e) => e.ts > now && e.tier <= 2 && insideWindow(e.ts, state.window));
  if (evs.length) {
    html += `<div class="hr"></div><p class="card-title">Landing while you are at the screen</p>`;
    for (const e of evs.slice(0, 4)) {
      html += `<div class="row"><dt>${esc(e.short || e.name)}</dt>
        <dd style="color:var(--${e.tier === 1 ? 'danger' : 'warn'})">${formatHM(e.ts, state.window.tz)} · ${formatCountdown(e.msAway)}</dd></div>`;
    }
  }

  el.innerHTML = html;
}

/* ============================================================ conditions */

function renderConditions(a, now) {
  const q = sessionQuality(now, state.pair, state.window);
  const roll = rolloverWindow(now, state.serverOffset === '' ? null : Number(state.serverOffset));
  const boundary = barBoundaryNote(now);

  const sv = a.ok && a.atr ? spreadViability(currentSpread(), a.atr) : { ok: null };

  let html = `<p class="card-title">Conditions</p>
    <div class="chips">
      <span class="chip ${q.band === 'green' ? 'green' : (q.band === 'red' || q.band === 'dead') ? 'red' : 'amber'}">${esc(q.name)}</span>
      ${a.ok && a.regime ? `<span class="chip">${esc(a.regime.regime)}</span>` : ''}
      ${a.ok && a.htf && a.htf.agree ? '<span class="chip green">M15 and H1 agree</span>' : '<span class="chip amber">Timeframes disagree</span>'}
    </div>
    <p style="font-size:13px;color:var(--label-2);margin:11px 0 0">${esc(q.note)}</p>`;

  if (a.ok && a.atr) {
    html += `<div class="hr"></div>
      <div class="row"><dt>M5 ATR(14)</dt><dd>${fmt(a.atr)} <span style="color:var(--label-3)">${((a.atr / a.price) * 100).toFixed(2)}%</span></dd></div>`;
    if (sv.ok !== null) {
      const col = sv.ok ? (sv.ratio <= 0.25 ? 'up' : 'warn') : 'danger';
      html += `<div class="row"><dt>Spread as share of ATR</dt><dd style="color:var(--${col})">${sv.pct}%</dd></div>
        <p style="font-size:12.5px;color:var(--label-2);margin:9px 0 0">${esc(sv.verdict)}</p>`;
    } else {
      html += `<p style="font-size:12.5px;color:var(--label-3);margin:9px 0 0">Enter your live spread under Size to see whether the cost structure supports a scalp right now. It is the single ratio that decides it.</p>`;
    }
  }

  if (roll && roll.warning) html += `<div class="unconfirmed" style="color:var(--danger);background:var(--danger-dim)">${esc(roll.warning)}</div>`;
  if (boundary.strong) html += `<div class="unconfirmed">${esc(boundary.note)}</div>`;
  if (a.ok && a.regime) html += `<p style="font-size:12.5px;color:var(--label-3);margin:11px 0 0">${esc(a.regime.notes.join(' · '))}</p>`;

  $('conditions').innerHTML = html;
}

/* =============================================================== blackout */

function renderBlackout(bl, now) {
  const slot = $('blackout-slot');
  if (!bl) {
    const next = getUpcomingEvents(now, 12, state.pair, { includeContext: false })
      .filter((e) => e.tier <= 2 && e.ts > now)[0];
    if (next && next.msAway < 75 * 60000) {
      slot.innerHTML = `<div class="alert caution">
        <h3>${esc(next.name)} in <span class="num">${formatCountdown(next.msAway)}</span></h3>
        <p>Tier ${next.tier}. Lands ${formatHM(next.ts, state.window.tz)} ${zoneLabel()} — plan to be flat by ${formatHM(next.ts - next.blackoutBefore * 60000, state.window.tz)}.</p></div>`;
    } else {
      slot.innerHTML = '';
    }
    return;
  }
  const ev = bl.event;
  slot.innerHTML = `<div class="alert stand-aside">
    <h3>Stand aside &mdash; ${esc(ev.name)}</h3>
    <div class="big-count">${bl.phase === 'before' ? formatCountdown(ev.ts - now) : `+${bl.minutesSince}m`}</div>
    <p style="margin-top:6px">${bl.phase === 'before'
      ? 'Spreads widen and stops get skipped through before the number lands, not after.'
      : 'The spread has not normalised yet. The release candle and the one after it are frequently a false direction.'}</p>
    <p style="margin-top:8px;color:var(--label-3);font-size:12.5px">Lands ${formatHM(bl.event.ts, state.window.tz)} · clear at ${formatHM(bl.endsAtMs, state.window.tz)} ${zoneLabel()}${state.serverOffset !== '' ? ` · ${brokerChartTime(bl.endsAtMs, Number(state.serverOffset)).text} on your chart` : ''}.</p>
  </div>`;
}

/* =================================================================== news */

function eventRow(e, now) {
  const cls = e.tier === 1 ? 't1' : e.tier === 2 ? 't2' : e.tier === 3 ? 't3' : 'tc';
  const past = e.ts < now;
  const bt = state.serverOffset !== '' ? brokerChartTime(e.ts, Number(state.serverOffset)) : null;
  return `<div class="ev">
    <div class="ev-stripe ${cls}"></div>
    <div>
      <div class="ev-name">${esc(e.name)}${e.confidence !== 'verified' ? `<span class="flag">${e.approximate ? 'approx' : 'unconfirmed'}</span>` : ''}${e.dateShifted ? '<span class="flag">shifted</span>' : ''}</div>
      <div class="ev-meta">${esc(e.agency)} · ${e.tier === 'context' ? 'context only' : `tier ${e.tier}`}${e.tier !== 'context' ? ` · flat ${e.blackoutBefore}m before, ${e.blackoutAfter}m after` : ''}</div>
      <div class="ev-why">${esc(e.why)}</div>
      ${e.note ? `<details class="more"><summary>Caveat</summary><p style="font-size:12.5px;color:var(--label-2);margin:5px 0 0">${esc(e.note)}</p></details>` : ''}
    </div>
    <div class="ev-when">
      <div class="ev-count" style="color:var(--${past ? 'label-3' : e.tier === 1 ? 'danger' : e.tier === 2 ? 'warn' : 'label'})">${past ? 'past' : formatCountdown(e.msAway)}</div>
      <div class="ev-clock">${formatHM(e.ts, state.window.tz)} ${esc(zoneLabel())}</div>
      ${bt ? `<div class="ev-clock">${bt.text} chart</div>` : ''}
    </div>
  </div>`;
}

function renderNews(now) {
  // Seven days rather than two: opened on a Saturday, a 48-hour window shows
  // almost nothing and reads as "nothing is coming" when Monday is stacked.
  const rows = getUpcomingEvents(now, 24 * 7, state.pair);
  const dst = dstMisalignment(now);

  $('dst-slot').innerHTML = dst ? `<div class="alert caution">
    <h3>Clocks are out of step this week</h3>
    <p>${esc(dst.message)} ${esc(dst.note)}. Normal service resumes ${esc(dst.to)}.</p></div>` : '';

  // Split by whether it will actually reach him. A release three hours after
  // he has closed the laptop is a different kind of fact from one landing
  // mid-session, and collapsing them into one list hides that.
  const inside = rows.filter((e) => insideWindow(e.ts, state.window));
  const outside = rows.filter((e) => !insideWindow(e.ts, state.window));
  const zoneName = zoneLabel();

  $('news-inside').innerHTML = inside.length
    ? `<p class="card-title">While you are trading · next 7 days</p>${inside.slice(0, 26).map((e) => eventRow(e, now)).join('')}`
    : `<p class="card-title">While you are trading</p><p style="color:var(--label-2);font-size:13.5px;margin:0">Nothing scheduled inside your window for this instrument over the next week.</p>`;

  $('news-outside').innerHTML = outside.length
    ? `<p class="card-title">After you have stopped</p>
       <p style="font-size:12.5px;color:var(--label-2);margin:0 0 9px">
         These land outside ${esc(formatHM(windowState(now, state.window).opensAtMs, state.window.tz))}–${esc(formatHM(windowState(now, state.window).closesAtMs, state.window.tz))} ${esc(zoneName)}.
         They matter only if you are still holding something, or thinking of opening a position late in your session that would run into one.
         The FOMC statement is the standing example: 14:00 New York is 19:00 in London, three hours after you have finished.</p>
       ${outside.slice(0, 14).map((e) => eventRow(e, now)).join('')}`
    : '';

  $('unschedulable').innerHTML = `<p class="card-title">What no calendar can time</p>
    <ul class="reasons against">${UNSCHEDULABLE.map((u) => `<li>${esc(u)}</li>`).join('')}</ul>
    <p style="font-size:12.5px;color:var(--label-3);margin:11px 0 0">
      These have no schedule, so nothing here can warn you about them. The only honest protection is
      position size and a stop that is already in the market.</p>`;

  const urgent = rows.find((e) => e.tier === 1 && e.msAway > 0 && e.msAway < 90 * 60000);
  $('news-badge').hidden = !urgent;
}

/* =================================================================== risk */

function currentSpread() {
  const v = Number($('live-spread').value);
  return v > 0 ? v : null;
}

function renderRisk() {
  const a = state.lastAnalysis;
  const i = inst();
  const bal = Number($('acct-bal').value) || 0;
  const pct = Number($('risk-pct').value) || 0;
  const ccy = $('acct-ccy').value;
  const gbpusd = Number($('fx-rate').value) || 1;
  const pointSize = Number($('point-size').value) || 0.10;
  // Margin here is leverage-derived, not a fixed percentage: the specification
  // says Calculation: Forex with margin currency XAU, so margin per lot is
  // contractSize / leverage ounces, converted at the live gold price.
  const leverage = Number($('leverage').value) || 20;
  const marginFactor = 1 / leverage;
  const spread = currentSpread() || 0;
  const commission = Number($('commission').value) || 0;
  const price = a && a.ok ? a.price : 0;

  let stop = Number($('stop-dist').value);
  if (!(stop > 0) && a && a.ok && a.stopDistance) {
    stop = +a.stopDistance.toFixed(dp());
    $('stop-dist').placeholder = String(stop);
  }

  const contract = Number($('contract-size').value) || spec(i, 'contractSize');
  const fx = ccy === 'USD' ? 1 : gbpusd;

  const r = sizeBothModels({
    equity: bal, riskPercent: pct, stopDistance: stop, price,
    pointSize, contractSize: contract, marginFactor, fxRate: fx,
    accountCurrency: ccy, spread, commissionPerLotRoundTurn: commission,
    lotStep: Number($('lot-step').value) || spec(i, 'lotStep'),
    minLot: Number($('min-lot').value) || spec(i, 'minLot'),
  });

  /* ---- the ticket: exactly what goes into the MT5 order form ---- */
  const digits = Number($('digits').value) || dp();
  const stopsLevel = Number($('stops-level').value) || 0;
  const side = a && a.ok && a.bias === 'long' ? 'buy' : a && a.ok && a.bias === 'short' ? 'sell' : null;
  const tk = (side && a.invalidation)
    ? mt5Ticket({
        side, entry: a.price, invalidation: a.invalidation,
        target: a.targets && a.targets.length ? a.targets[0].price : null,
        lots: r.ok ? r.cfd.lots : 0, digits, stopsLevel,
      })
    : null;

  if (!tk) {
    const why = !a || !a.ok ? 'No read yet.'
      : a.state === 'stand-aside' ? `Standing aside for ${esc(a.headline.replace(/^Stand aside — /, ''))}.`
      : a.state === 'stand-down' ? `${esc(a.headline)} — the read is being withheld.`
      : a.bias === 'neutral' ? 'No directional read, so there is no ticket to fill.'
      : 'Not enough to build a ticket.';
    $('ticket').innerHTML = `<p class="card-title">Type this into MT5</p>
      <p style="font-size:13.5px;color:var(--label-2);margin:0">${why}</p>`;
  } else {
    $('ticket').innerHTML = `
      <p class="card-title">Type this into MT5</p>
      <span class="ticket-side ${tk.side}">${tk.side.toUpperCase()} ${esc(inst().display)}</span>
      <div class="ticket">
        <div class="tk"><div class="tk-lab"><b>Volume</b>lots</div><div class="tk-val">${tk.volume.toFixed(2)}</div></div>
        <div class="tk"><div class="tk-lab"><b>Stop loss</b>price level</div><div class="tk-val down">${fmt(tk.stopLoss, digits)}</div></div>
        ${tk.takeProfit !== null
          ? `<div class="tk"><div class="tk-lab"><b>Take profit</b>price level</div><div class="tk-val up">${fmt(tk.takeProfit, digits)}</div></div>`
          : ''}
      </div>
      ${tk.warning ? `<div class="unconfirmed" style="color:var(--danger);background:var(--danger-dim)">${esc(tk.warning)}</div>` : ''}
      ${(() => {
        const sp = orderSplit(tk.volume, Number($('max-volume').value) || 0);
        return sp && sp.needsSplit
          ? `<div class="unconfirmed" style="color:var(--warn);background:var(--warn-dim)">${esc(sp.text)}</div>` : '';
      })()}
      ${(() => {
        const fr = fillRisk({ lots: tk.volume, contractSize: contract, fillMode: $('fill-mode').value });
        return fr && fr.large ? `<div class="unconfirmed">${esc(fr.text)}</div>` : '';
      })()}
      <p style="font-size:12.5px;color:var(--label-2);margin:12px 0 0">
        Stop and target are <b>absolute price levels</b>, which is what the mobile ticket expects —
        not distances. Market price was ${fmt(a.price, digits)} when this was computed;
        if it has moved, the levels still hold but the risk no longer matches.</p>
      ${(() => {
        const n = inst().chartIsBid ? bidChartNote(tk.side, spread || inst().typicalSpread?.observed || 0, digits) : null;
        return n
          ? `<div class="unconfirmed" style="${n.aligned ? 'color:var(--label-2);background:var(--surface-3)' : ''}">${esc(n.text)}</div>`
          : '';
      })()}
      <details class="more"><summary>Where these go in the app</summary>
        <p style="font-size:13px;color:var(--label-2);margin:6px 0 0">
          <b>Quotes</b> &rarr; tap the symbol &rarr; the order ticket. Put the volume in
          <b>Volume</b>, then the two levels in <b>Stop Loss</b> and <b>Take Profit</b>, then
          ${tk.side === 'buy' ? 'the blue <b>BUY</b> button on the right' : 'the blue <b>SELL</b> button on the left'}.
          <br><br>
          On many brokers the stop and target fields are greyed out under Market Execution until the
          position exists — if so, place it, then long-press the row on the <b>Trade</b> tab and use
          <b>Modify Position</b> to set them. Worth knowing before a news window rather than during one:
          the same Trade tab closes everything in a couple of taps.</p>
      </details>`;
  }

  /* ---- the two models, side by side ---- */
  if (!r.ok) {
    $('size-out').innerHTML = `<div class="unconfirmed">${r.blocked.map(esc).join('<br>')}</div>`;
    $('margin-gate').innerHTML = '';
    $('point-check').innerHTML = '';
  } else {
    $('size-out').innerHTML = `
      <div class="row"><dt>Volume</dt><dd style="font-size:22px;font-weight:700">${r.cfd.lots.toFixed(2)} lots</dd></div>
      <div class="row"><dt>Contract size</dt><dd>${contract} per lot</dd></div>
      ${r.cfd.belowMinimum ? `<div class="unconfirmed">${esc(r.cfd.note)}</div>` : ''}
      <div class="hr"></div>
      <div class="row"><dt>Risk budget</dt><dd>${ccy} ${fmt(r.riskBudget, 2)}</dd></div>
      <div class="row"><dt>Actual risk</dt><dd>${ccy} ${fmt(r.cfd.actualRisk, 2)}</dd></div>
      <div class="row"><dt>Stop incl. spread</dt><dd>${fmt(r.effectiveStop)} · ${r.stopFractionOfPrice}% of price</dd></div>`;

    /* ---- the margin gate: the constraint that actually binds ---- */
    const m = r.margin;
    const mpl = marginPerLot(contract, leverage, price);
    $('margin-gate').innerHTML = `
      <p class="card-title">Margin</p>
      ${mpl ? `<div class="row"><dt>Per 1.00 lot at 1:${leverage}</dt><dd>${mpl.units} oz · ${fmt(mpl.amount, 0)} USD</dd></div>` : ''}
      <div class="row"><dt>Notional</dt><dd>${ccy} ${fmt(m.notional, 0)}</dd></div>
      <div class="row"><dt>Margin required</dt><dd style="color:var(--${m.over ? 'danger' : 'label'})">${ccy} ${fmt(m.amount, 2)}</dd></div>
      <div class="row"><dt>Share of account</dt><dd style="color:var(--${m.over ? 'danger' : 'up'});font-size:19px;font-weight:700">${m.pctOfEquity}%</dd></div>
      ${(() => {
        const posture = marginPosture({
          marginPct: m.pctOfEquity / 100, leverage, equity: bal,
          marginPerLotAccount: mpl ? mpl.amount / fx : null, wantedLots: r.cfd.lots,
        });
        if (!posture) return '';
        const cls = posture.state === 'comfortable' ? ' ok' : '';
        return `<div class="gate${cls}">
          <h4>${esc(posture.headline)}</h4>
          <p>${posture.state === 'binding' ? esc(m.verdict) : esc(posture.text)}</p>
        </div>`;
      })()}
      <details class="more"><summary>Why a tighter stop costs more margin, not less</summary>
        <p style="font-size:12.5px;color:var(--label-2);margin:6px 0 0">
          Margin as a share of the account is <span class="num">m × r ÷ s</span> — the margin factor,
          times your risk %, divided by the stop expressed as a <i>fraction of price</i>. Account size
          cancels out, and so does the price level. Tightening the stop while holding risk constant
          means a bigger position, and a bigger position needs more margin.
          <br><br>
          This is why inherited dollar rules mislead. A $3.00 stop was 0.15% of price when gold was
          $2,000 and used about a third of an account. At ${fmt(price)} the same $3.00 is
          ${r.stopFractionOfPrice}% and uses ${m.pctOfEquity}%. The requirement tightens every time
          gold rises.</p>
      </details>`;

    /* ---- point size: firm-specific, and a 10x trap if wrong ---- */
    const rows = stakeAcrossPointSizes(bal, pct, r.effectiveStop);
    $('point-check').innerHTML = `
      <p style="font-size:13px;color:var(--label-2);margin:11px 0">
        You type lots into MT5 whichever kind of account this is, so this is only a cross-check —
        useful if your statement or another platform shows the position per point.</p>
      ${rows.map((x) => `<div class="row" style="${x.pointSize === pointSize ? 'opacity:1' : 'opacity:.45'}">
        <dt>$${x.pointSize.toFixed(2)} per point${x.pointSize === pointSize ? ' · selected' : ''}</dt>
        <dd>${ccy} ${x.stake.toFixed(2)}/pt over ${x.stopPoints} pts</dd></div>`).join('')}
      <div class="hr"></div>
      <div class="row"><dt>Exposure per $1 move</dt><dd>${ccy} ${rows.length ? rows[0].perDollarMove.toFixed(2) : '—'}</dd></div>
      <p style="font-size:12.5px;color:var(--label-2);margin:11px 0 0">
        Identical under all three, which is the point — the conventions differ in how the stake is
        written down, not in what you are exposed to. There is no standard: $0.01, $0.10 and $1.00
        are all in live use at UK firms, including at the largest ones, so there is no safe default
        to assume. If you want this column to be right, take the value from your own contract details.</p>
      ${r.bridge.reconciles ? `<p style="font-size:12px;color:var(--label-3);margin:9px 0 0">
        Cross-check: ${ccy} ${r.bridge.stakeFromLots}/pt is the same position as ${r.bridge.lotsFromStake} lots.
        The two agree exactly before rounding.</p>` : ''}`;
  }

  /* ---- is this practice teaching anything transferable? ---- */
  const liveBal = Number($('live-balance').value) || 0;
  const realism = practiceRealism(bal, liveBal);
  const realismHtml = realism && !realism.ok
    ? `<div class="unconfirmed">${esc(realism.text)}</div>` : '';

  /* ---- cost of scalping ---- */
  const allIn = allInSpread(spread, commission, contract);
  let cost = '<p class="card-title">What scalping costs you</p>';
  if (r.ok && r.cfd.lots > 0 && spread > 0) {
    const d = spreadDrag({
      spread, valuePerUnitMovePerLot: contract, lots: r.cfd.lots,
      tradesPerDay: 15, commissionPerLotRoundTurn: commission,
    });
    cost += `<div class="row"><dt>Per trade</dt><dd>${ccy} ${fmt(d.perTrade / fx, 2)}</dd></div>
      ${commission > 0 ? `<div class="row"><dt style="padding-left:12px;color:var(--label-3)">of which spread</dt><dd style="color:var(--label-3)">${ccy} ${fmt(d.spreadPart / fx, 2)}</dd></div>
      <div class="row"><dt style="padding-left:12px;color:var(--label-3)">of which commission</dt><dd style="color:var(--warn)">${ccy} ${fmt(d.commissionPart / fx, 2)} · ${d.commissionShare}%</dd></div>` : ''}
      <div class="row"><dt>15 trades a day</dt><dd>${ccy} ${fmt(d.perDay / fx, 2)}</dd></div>
      <div class="row"><dt>Over a month</dt><dd style="color:var(--warn);font-size:17px;font-weight:700">${ccy} ${fmt(d.perMonth / fx, 2)}</dd></div>
      ${commission > 0 ? `<div class="row"><dt>All-in, as a spread</dt><dd>${fmt(allIn)} per oz</dd></div>` : ''}
      <p style="font-size:12.5px;color:var(--label-2);margin:11px 0 0">
        Paid whether you are right or wrong, before a single losing trade.
        ${commission > 0 && d.commissionShare >= 40
          ? `Note that commission is <b>${d.commissionShare}%</b> of it — on a tight-spread account the commission is usually the larger half, and a cost model that counted only the spread would understate this by about that much.`
          : spread > 0 && spread < 0.10 && commission === 0
            ? 'A spread this tight almost always means a raw or ECN account that charges commission separately. If yours does, enter it above — otherwise this figure is missing the larger half of your costs.'
            : 'It is why a scalping edge has to be larger than it first looks.'}</p>`;
  } else {
    cost += '<p style="color:var(--label-2);font-size:13.5px;margin:0">Enter your live spread and a stop distance to see the monthly toll.</p>';
  }
  // Break-even must use the ALL-IN cost, not the raw spread, or a raw account
  // looks cheaper to trade than it is.
  const be = stop > 0 && a && a.ok && a.targets && a.targets.length
    ? breakEvenWinRate(Math.abs(a.targets[0].price - a.price), stop, allIn || spread) : null;
  if (be && !be.impossible) {
    cost += `<div class="hr"></div>
      <div class="row"><dt>Gross reward:risk</dt><dd>${be.grossR}R</dd></div>
      <div class="row"><dt>Net of spread</dt><dd>${be.netR}R</dd></div>
      <div class="row"><dt>Break-even win rate</dt><dd style="color:var(--${be.rate > 55 ? 'warn' : 'label'})">${be.rate}%</dd></div>
      <div class="row"><dt>If the spread were free</dt><dd style="color:var(--label-3)">${be.costlessRate}%</dd></div>
      <p style="font-size:12.5px;color:var(--label-2);margin:9px 0 0">
        The gap between those two is what the spread costs you in win rate.
        You need <b>${be.rate}%</b>, not ${be.costlessRate}%.</p>`;
  }
  cost += `<div class="hr"></div>
    <p style="font-size:12.5px;color:var(--label-3);margin:0">
      Overnight financing is left out of this deliberately, not silently: it is charged at the daily
      cut, around 22:00 London, and you are flat by 16:00. If you ever hold past the cut, this
      understates the cost.</p>`;
  $('cost-out').innerHTML = cost + realismHtml;

  /* ---- cost floor and correlation ---- */
  const goldFloor = costFloorBps(Number(state.spread.XAUUSD) || 0.35, 4391);
  const btcFloor = costFloorBps(Number(state.spread.BTCUSD) || 30, 81000);
  let floorHtml = '';
  if (goldFloor && btcFloor) {
    floorHtml = `<p class="card-title">Cost floor per round trip</p>
      <div class="row"><dt>Gold</dt><dd>${goldFloor} bps</dd></div>
      <div class="row"><dt>Bitcoin</dt><dd style="color:var(--warn)">${btcFloor} bps</dd></div>
      <p style="font-size:12.5px;color:var(--label-2);margin:9px 0 0">
        Bitcoin needs roughly ${(btcFloor / goldFloor).toFixed(1)}x the move gold does just to get back
        to flat, at every hour of your day. ${state.spread.XAUUSD && state.spread.BTCUSD
        ? 'Computed from the spreads you entered.' : 'Using indicative spreads until you enter your own on each instrument.'}</p>
      <div class="hr"></div>`;
  }
  /* ---- what the account rules actually are, and what to check ---- */
  // Every authoritative source was unreachable from the build environment, so
  // this is search-snippet evidence quoting the Handbook rather than a page
  // anyone opened. It is date-stamped rather than asserted as current, and it
  // never tells the user what their own account is — only what to go and look at.
  $('account-note').innerHTML = `
    <p class="card-title">Account rules worth knowing</p>
    <div class="row"><dt>Major FX, some sovereign debt</dt><dd>3.33% · 30:1</dd></div>
    <div class="row"><dt>Gold, major indices, minor FX</dt><dd style="color:var(--label)">5% · 20:1</dd></div>
    <div class="row"><dt>Other commodities, minor indices</dt><dd>10% · 10:1</dd></div>
    <div class="row"><dt>Shares and anything else listed</dt><dd>20% · 5:1</dd></div>
    <p style="font-size:12.5px;color:var(--label-2);margin:11px 0 0">
      Gold is carved out of the commodity tier, so it gets 20:1 rather than 10:1. These apply to
      spread bets and rolling spot forex as well as CFDs where they are MiFID instruments — spread
      betting is not a route to more leverage at a UK firm.</p>

    <div class="hr"></div>
    <p class="card-title">The close-out rule</p>
    <p style="font-size:13px;color:var(--label-2);margin:0">
      A firm must close your positions once <b>net equity</b> — deposited margin plus unrealised
      profit and loss — falls below <b>50% of the margin required to maintain them</b>. Three things
      about that are easy to get wrong: it is measured per <i>account</i> across everything open, not
      per position; the benchmark is maintenance margin, not what it took to open; and the obligation
      is to close "as soon as market conditions allow", which is a trigger rather than a guaranteed
      fill. A gap can carry straight through it.</p>
    <p style="font-size:12.5px;color:var(--label-3);margin:9px 0 0">
      This is the other reason the margin figure above matters. At 73% of the account in margin there
      is very little room between a normal adverse move and that trigger.</p>

    ${state.pair === 'BTCUSD' ? `
    <div class="hr"></div>
    <p class="card-title">On the bitcoin leg</p>
    <p style="font-size:13px;color:var(--label-2);margin:0">
      Since 6 January 2021, FCA rules have barred firms acting in or from the UK from selling crypto
      derivatives — CFDs, futures, options and spread bets on bitcoin — to <b>retail</b> clients. The
      one relaxation came on <b>8 October 2025</b> and is narrow: crypto ETNs listed on a UK Recognised
      Investment Exchange may now be sold to retail, and those are not FSCS-protected. It does not
      cover margin trading of BTCUSD.</p>
    <p style="font-size:13px;color:var(--label-2);margin:9px 0 0">
      So a BTCUSD position held from the UK is generally not with an FCA firm on a retail basis. It is
      usually a non-UK entity of the same broker, a broker outside the UK perimeter, or an account
      where you have been classified as an elective professional. <b>Worth checking which</b> — the
      entity name and regulator on your statement, not the brand on the app. The prohibition is
      addressed to firms, not to you.</p>
    <p style="font-size:12.5px;color:var(--label-3);margin:9px 0 0">
      It matters because the protections differ. On a non-UK entity you are outside the FCA leverage
      caps, client-money rules, FSCS cover (£85,000 per person per firm for investment business) and
      the Financial Ombudsman, and negative balance protection becomes whatever your contract says
      rather than a rule. Elective professional status at a UK firm is a different case and less
      clear-cut — it removes the leverage caps and the NBP <i>requirement</i>, but an individual
      acting outside their trade or business can still be an eligible complainant, and firms
      sometimes provide negative balance protection contractually anyway. Read the agreement rather
      than assuming either way.</p>` : ''}

    <div class="hr"></div>
    <p style="font-size:12px;color:var(--label-3);margin:0">
      On tax: the treatment of spread bets and CFDs differs, and it depends on your own circumstances
      and on whether HMRC considers a trade is being carried on. That is genuinely not something this
      tool should assert, so it does not. HMRC's guidance and an accountant are the right sources.
    </p>
    <p style="font-size:12px;color:var(--label-3);margin:9px 0 0">
      Checked against Handbook extracts on 20 September 2026 — not read from the FCA's own site, which
      was unreachable. Corroborating evidence reaches roughly mid-2025, so treat it as a prompt to
      verify rather than as current fact.</p>`;

  renderEdge(allIn || spread, contract);

  $('corr-note').innerHTML = floorHtml + `<p class="card-title">You trade both of these</p>
    <p style="font-size:13.5px;color:var(--label-2);margin:0">${esc(CORRELATION_NOTE.message)}</p>
    <p style="font-size:12px;color:var(--label-3);margin:9px 0 0">
      ${esc(CORRELATION_NOTE.window)} correlation ${CORRELATION_NOTE.value}, as of ${esc(CORRELATION_NOTE.asOf)}.
      Correlations move — this one swung hard during 2026. Treat it as a live assumption to re-check,
      not a constant.</p>`;
}

/* ============================================== is it working yet? ====== */

/**
 * The honest answer to "am I any good at this", which is usually "not enough
 * trades to say" for far longer than anyone expects.
 */
function renderEdge(costPrice, contract) {
  const trades = Number($('rec-trades').value) || 0;
  const wins = Number($('rec-wins').value) || 0;
  const rr = Number($('rec-rr').value) || 1;
  const perDay = Number($('rec-perday').value) || 5;
  const a = state.lastAnalysis;
  const stop = Number($('stop-dist').value) || (a && a.ok && a.stopDistance) || 0;
  const costInRisk = stop > 0 && costPrice > 0 ? costPrice / stop : 0;

  if (!trades) {
    const be = breakEvenRate(rr, costInRisk);
    const need = be ? tradesNeeded(be + 0.05, be) : null;
    const t = need ? timeToSample(need, perDay) : null;
    $('edge-out').innerHTML = `<div class="hr"></div>
      <p style="font-size:13px;color:var(--label-2);margin:0">
        Log your trades here and this will tell you whether the result means anything yet.
        ${be ? `At ${rr}:1 with your current costs, break-even is <b>${(be * 100).toFixed(1)}%</b> — not 50%.` : ''}
        ${t ? ` Proving a five-point edge over that would take roughly <b>${need} trades</b>, about ${t.months} months at ${perDay} a day.` : ''}</p>`;
    return;
  }

  const r = assessRecord({ trades, wins, rewardRisk: rr, costInRisk });
  if (!r || r.impossible) {
    $('edge-out').innerHTML = `<div class="hr"></div><div class="unconfirmed">${esc(r ? r.reason : 'Winners cannot exceed trades.')}</div>`;
    return;
  }

  const tone = r.verdict === 'edge' ? 'up' : r.verdict === 'negative' ? 'danger' : 'warn';
  const st = expectedStreak(Math.max(0.05, Math.min(0.95, r.observedRate)), Math.max(trades, 300));

  $('edge-out').innerHTML = `<div class="hr"></div>
    <div class="row"><dt>Observed</dt><dd>${(r.observedRate * 100).toFixed(1)}%</dd></div>
    <div class="row"><dt>Break-even after costs</dt><dd>${(r.breakEven * 100).toFixed(1)}%</dd></div>
    <div class="row"><dt>True rate is somewhere in</dt><dd>${(r.ci[0] * 100).toFixed(0)}–${(r.ci[1] * 100).toFixed(0)}%</dd></div>
    <div class="row"><dt>Expectancy</dt><dd style="color:var(--${r.expectancyR > 0 ? 'up' : 'down'})">${r.expectancyR > 0 ? '+' : ''}${r.expectancyR.toFixed(3)}R ± ${(1.96 * r.expectancySe).toFixed(3)}</dd></div>
    <div class="gate${r.verdict === 'edge' ? ' ok' : ''}" style="${r.verdict === 'inconclusive' ? 'background:var(--warn-dim);border-color:rgba(255,214,10,.35)' : ''}">
      <h4 style="color:var(--${tone})">${r.verdict === 'edge' ? 'Evidence of an edge' : r.verdict === 'negative' ? 'Evidence against it' : 'Not enough trades to say'}</h4>
      <p>${esc(r.text)}</p>
    </div>
    ${st ? `<p style="font-size:12.5px;color:var(--label-2);margin:11px 0 0">
      At this rate, a losing run of <b>${st.likelyWorst}</b> is more likely than not within 300 trades, and
      ${((st.rows.find((x) => x.length === st.likelyWorst + 2) || {}).probability * 100 || 0).toFixed(0)}% of samples see ${st.likelyWorst + 2} in a row. Expect it. A run like that is what
      the arithmetic predicts, not a sign the approach has stopped working — and abandoning a system
      mid-run is how the sample never gets large enough to answer the question.</p>` : ''}`;
}

/* ================================================================== chart */

function drawChart(a) {
  const cv = $('chart');
  const ratio = window.devicePixelRatio || 1;
  const cssW = cv.clientWidth || 340, cssH = 190;
  cv.width = cssW * ratio; cv.height = cssH * ratio;
  const g = cv.getContext('2d');
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  g.clearRect(0, 0, cssW, cssH);

  const bars = state.bars.slice(-70);
  if (!bars.length) return;

  const padL = 6, padR = 52, padT = 10, padB = 8;
  const W = cssW - padL - padR, H = cssH - padT - padB;
  let lo = Infinity, hi = -Infinity;
  for (const b of bars) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
  if (a && a.ok && a.invalidation) { lo = Math.min(lo, a.invalidation); hi = Math.max(hi, a.invalidation); }
  const pad = (hi - lo) * 0.08 || 1;
  lo -= pad; hi += pad;
  const y = (p) => padT + H - ((p - lo) / (hi - lo)) * H;
  const bw = W / bars.length;

  // horizontal guides + right-hand price labels
  g.font = '9px ui-monospace, monospace';
  g.textAlign = 'left';
  for (let i = 0; i <= 3; i++) {
    const p = lo + ((hi - lo) * i) / 3;
    const yy = y(p);
    g.strokeStyle = '#242428'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(padL, yy); g.lineTo(padL + W, yy); g.stroke();
    g.fillStyle = '#6A6A70';
    g.fillText(p.toFixed(dp()), padL + W + 6, yy + 3);
  }

  // session VWAP
  if (a && a.ok && a.indicators && a.indicators.vwap) {
    const vw = a.indicators.vwap.vwap.slice(-bars.length);
    g.strokeStyle = 'rgba(10,132,255,.85)'; g.lineWidth = 1.4;
    g.beginPath();
    let started = false;
    vw.forEach((v, i) => {
      if (v === null) { started = false; return; }
      const xx = padL + i * bw + bw / 2;
      // A session-anchored VWAP restarts at each reset, so the value jumps.
      // Joining across that gap would draw a vertical line that looks like a
      // price move. Break the path instead and start a new segment.
      const jumped = i > 0 && vw[i - 1] !== null
        && Math.abs(v - vw[i - 1]) > (hi - lo) * 0.08;
      if (!started || jumped) { g.moveTo(xx, y(v)); started = true; } else g.lineTo(xx, y(v));
    });
    g.stroke();
  }

  // clustered levels
  if (a && a.ok && a.levels) {
    for (const L of a.levels.slice(0, 5)) {
      if (L.price < lo || L.price > hi) continue;
      g.strokeStyle = 'rgba(155,155,161,.32)';
      g.setLineDash([3, 4]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(padL, y(L.price)); g.lineTo(padL + W, y(L.price)); g.stroke();
      g.setLineDash([]);
    }
  }

  // candles
  bars.forEach((b, i) => {
    const x = padL + i * bw + bw / 2;
    const up = b.c >= b.o;
    g.strokeStyle = up ? '#30D9A4' : '#FF6B4A';
    g.fillStyle = up ? '#30D9A4' : '#FF6B4A';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y(b.h)); g.lineTo(x, y(b.l)); g.stroke();
    const bodyW = Math.max(1.5, bw * 0.62);
    const top = y(Math.max(b.o, b.c)), bot = y(Math.min(b.o, b.c));
    g.fillRect(x - bodyW / 2, top, bodyW, Math.max(1, bot - top));
  });

  // invalidation
  if (a && a.ok && a.invalidation) {
    const col = a.bias === 'long' ? '#FF6B4A' : '#30D9A4';
    g.strokeStyle = col; g.lineWidth = 1.2; g.setLineDash([5, 3]);
    g.beginPath(); g.moveTo(padL, y(a.invalidation)); g.lineTo(padL + W, y(a.invalidation)); g.stroke();
    g.setLineDash([]);
    g.fillStyle = col; g.font = '600 9px ui-monospace, monospace'; g.textAlign = 'left';
    g.fillText('invalid', padL + W + 6, y(a.invalidation) + 3);
  }

  $('chart-chips').innerHTML = `
    <span class="chip" style="color:var(--accent)">&mdash; session VWAP</span>
    <span class="chip">&middot;&middot;&middot; levels</span>
    ${a && a.ok && a.invalidation ? '<span class="chip">- - invalidation</span>' : ''}
    <span class="chip">${bars.length} bars</span>`;
}

/* ============================================================== reasoning */

function renderReasoning(a) {
  if (!a.ok || !a.reasons || !a.reasons.length || !a.weights) {
    $('reasoning').innerHTML = a.reasons && a.reasons.length
      ? `<p class="card-title">What it sees</p><ul class="reasons">${a.reasons.map((r) => `<li>${esc(typeof r === 'string' ? r : r.text)}</li>`).join('')}</ul>`
      : '<p class="card-title">What it sees</p><p style="color:var(--label-2);font-size:13.5px;margin:0">Not enough data to describe.</p>';
    $('whynot').innerHTML = a.whyNot && a.whyNot.length
      ? `<p class="card-title">The case against</p><ul class="reasons against">${a.whyNot.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
      : '';
    return;
  }
  $('reasoning').innerHTML = `<p class="card-title">What it sees</p>
    <ul class="reasons">${a.reasons.slice(0, 14).map((r) => `<li><b>${esc(r.bucket)}</b> — ${esc(r.text)}</li>`).join('')}</ul>
    <details class="more"><summary>How the score is weighted right now</summary>
      <div style="margin-top:8px">
        ${Object.entries(a.weights).map(([k, v]) => `<div class="row"><dt>${esc(k)}</dt><dd>${Math.round(v * 100)}%</dd></div>`).join('')}
      </div>
      <p style="font-size:12.5px;color:var(--label-3);margin:10px 0 0">
        Correlated indicators share a bucket, so trend-following measures cannot vote three times for
        one observation. Weights change with the regime. ${a.abstained && a.abstained.length
    ? `Abstaining this bar: ${a.abstained.map(esc).join(', ')} — that weight is removed, not redistributed.` : ''}</p>
    </details>`;

  $('whynot').innerHTML = `<p class="card-title">The case against</p>
    <ul class="reasons against">${a.whyNot.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`;
}

/* ================================================================= limits */

function renderLimits() {
  const i = inst();
  const un = unconfirmedFields(i, store.get('confirmed_' + state.pair, {}));
  $('spec-warn').innerHTML = un.length
    ? `These are defaults, not your broker's numbers: <b>${un.map((u) => esc(u.key)).join(', ')}</b>. Contract size in particular varies enough between brokers to scale every position by 100. Check them in the app and overwrite above.`
    : 'Specs confirmed.';

  $('limits').innerHTML = `<p class="card-title">What this does not do</p>
    <ul class="reasons against">
      <li>It cannot see order flow or the order book, and it has no real traded volume. What MT5 calls volume is <b>tick activity</b> — the number of price updates on your broker's feed, not contracts traded. It is allowed to scale or veto a read here, never to confirm direction.</li>
      <li>It reads a reference price, not your broker's. Your fill, spread and slippage are yours, and they diverge most at the moments it finds interesting.</li>
      <li>It has no track record and nothing in it is backtested. The weights are reasoned, not fitted.</li>
      <li>It knows <i>when</i> releases are scheduled. It cannot read the number, and it has no idea an unscheduled headline just landed.</li>
      <li>It does not watch the dollar, real yields or the Nasdaq. Gold can be technically perfect and get run over by a move in DXY.</li>
      <li>Release dates were gathered from search results, not read off the issuing agency. Anything marked <span class="flag">unconfirmed</span> needs checking against your broker's calendar.</li>
      <li>It will never tell you to buy or sell. It describes the chart and names the level it is wrong at. The decision stays yours.</li>
    </ul>
    <div class="hr"></div>
    <p style="font-size:12.5px;color:var(--label-3);margin:0">
      A note on the odds: most retail CFD accounts lose money, and scalping is the style where costs bite
      hardest, because the spread is paid in full on every trade while the target is small. The break-even
      win rate shown under Size is the honest version of that arithmetic. Nothing in this tool changes it.</p>`;
}

/* ================================================================== cycle */

function analyseNow() {
  const now = Date.now();
  const bl = getActiveBlackout(now, state.pair, state.overrides);
  const a = analyse({
    bars: state.bars,
    instrument: inst(),
    spread: currentSpread(),
    blackout: bl,
    session: {
      ...sessionQuality(now, state.pair, state.window),
      lastStretch: windowState(now, state.window).phase === 'last-30',
    },
    nowMs: now,
  });
  state.lastAnalysis = a;

  renderClock(); renderFeed();
  renderBlackout(bl, now);
  renderSessionCard(now);
  renderRead(a);
  renderConditions(a, now);
  renderReasoning(a);
  drawChart(a);
  renderNews(now);
  renderRisk();
  renderLimits();
}

async function refresh() {
  if (state.mode === 'manual') { analyseNow(); return; }
  $('feed-text').textContent = 'Connecting…';
  const res = await loadBars(state.pair, { keys: state.keys, limit: 300, allowProxy: true });
  if (res.ok) {
    state.bars = res.bars; state.feed = res; state.sample = false;
  } else {
    state.feed = res;
    if (!state.bars.length || state.sample) { state.bars = sampleBars(state.pair); state.sample = true; }
  }
  $('feed-detail').innerHTML = `<div class="hr"></div><p class="card-title">Feed attempts</p>` +
    (res.attempts || []).map((x) => `<div class="row"><dt>${esc(x.label)}</dt><dd style="color:var(--${x.ok ? 'up' : 'label-3'})">${x.ok ? `${x.bars} bars` : esc(x.reason)}</dd></div>`).join('') +
    (res.ok ? '' : `<p style="font-size:12.5px;color:var(--label-2);margin:11px 0 0">${esc(res.reason)}</p>`);
  analyseNow();
}

/* =================================================================== wire */

function selectTab(name) {
  state.tab = name;
  for (const t of ['read', 'news', 'risk', 'setup']) {
    $('tab-' + t).hidden = t !== name;
    $('nav-' + t).setAttribute('aria-selected', String(t === name));
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (name === 'read') drawChart(state.lastAnalysis);
}

function setPair(p) {
  state.pair = p; store.set('pair', p);
  $('pair-XAUUSD').setAttribute('aria-selected', String(p === 'XAUUSD'));
  $('pair-BTCUSD').setAttribute('aria-selected', String(p === 'BTCUSD'));
  const i = inst();
  $('contract-size').placeholder = String(spec(i, 'contractSize'));
  $('min-lot').placeholder = String(spec(i, 'minLot'));
  $('lot-step').placeholder = String(spec(i, 'lotStep'));
  $('digits').placeholder = String(spec(i, 'digits'));
  $('live-spread').value = state.spread[p] ?? '';
  state.bars = sampleBars(p); state.sample = true;
  analyseNow();
  refresh();
}

function boot() {
  $('pair-XAUUSD').onclick = () => setPair('XAUUSD');
  $('pair-BTCUSD').onclick = () => setPair('BTCUSD');
  for (const t of ['read', 'news', 'risk', 'setup']) $('nav-' + t).onclick = () => selectTab(t);

  $('mode').value = state.mode;
  $('manual-panel').hidden = state.mode !== 'manual';
  $('mode').onchange = (e) => {
    state.mode = e.target.value; store.set('mode', state.mode);
    $('manual-panel').hidden = state.mode !== 'manual';
    refresh();
  };

  $('key-twelvedata').value = state.keys.twelvedata || '';
  $('key-twelvedata').onchange = (e) => {
    state.keys = { ...state.keys, twelvedata: e.target.value.trim() };
    store.set('keys', state.keys); refresh();
  };

  $('server-offset').value = String(state.serverOffset);
  $('server-offset').onchange = (e) => {
    state.serverOffset = e.target.value === '' ? '' : Number(e.target.value);
    store.set('serverOffset', state.serverOffset); analyseNow();
  };

  $('refresh').onclick = refresh;

  const pad = (n) => String(n).padStart(2, '0');
  $('win-start').value = `${pad(state.window.start.h)}:${pad(state.window.start.m)}`;
  $('win-end').value = `${pad(state.window.end.h)}:${pad(state.window.end.m)}`;
  $('win-tz').value = state.window.tz;
  const saveWindow = () => {
    const [sh, sm] = $('win-start').value.split(':').map(Number);
    const [eh, em] = $('win-end').value.split(':').map(Number);
    if (![sh, sm, eh, em].every(Number.isFinite)) return;
    const tz = $('win-tz').value;
    state.window = {
      start: { h: sh, m: sm }, end: { h: eh, m: em }, tz,
      label: tz.split('/').pop().replace('_', ' '),
    };
    store.set('window', state.window);
    analyseNow();
  };
  for (const id of ['win-start', 'win-end', 'win-tz']) $(id).onchange = saveWindow;

  $('manual-apply').onclick = () => {
    const now = Date.now();
    const lines = $('manual-input').value.trim().split('\n').filter(Boolean);
    const rows = [];
    lines.forEach((ln, idx) => {
      const p = ln.trim().split(/[\s,]+/).map(Number);
      if (p.length >= 4 && p.every((x) => Number.isFinite(x))) {
        rows.push({ t: now - (lines.length - 1 - idx) * 300000, o: p[0], h: p[1], l: p[2], c: p[3], v: p[4] || 0 });
      }
    });
    if (rows.length < 5) {
      alert('Need at least 5 bars, one per line, as: open high low close');
      return;
    }
    state.bars = manualBars(rows); state.sample = false; state.feed = null;
    selectTab('read'); analyseNow();
  };

  for (const id of ['acct-bal', 'risk-pct', 'fx-rate', 'stop-dist', 'acct-ccy',
    'contract-size', 'min-lot', 'lot-step', 'point-size', 'leverage',
    'digits', 'stops-level', 'commission', 'live-balance', 'max-volume', 'fill-mode',
    'rec-trades', 'rec-wins', 'rec-rr', 'rec-perday']) {
    const el = $(id);
    if (el) { el.oninput = renderRisk; el.onchange = renderRisk; }
  }
  $('live-spread').oninput = () => {
    state.spread[state.pair] = $('live-spread').value;
    store.set('spread', state.spread);
    analyseNow();
  };

  setPair(state.pair);
  setInterval(() => { renderClock(); }, 1000);
  setInterval(() => { analyseNow(); }, 20000);
  // Poll on the bar, not on a timer.
  //
  // A five-minute chart carries no new information between bar closes, and the
  // free tiers are metered per day: Twelve Data's 800 daily credits vanish in
  // under seven hours at sixty-second polling, which means the feed dies
  // mid-session. So: wake a few seconds AFTER each 5-minute boundary, when the
  // closing bar is final, and not otherwise.
  const scheduleNextPoll = () => {
    const now = Date.now();
    const nextBar = Math.ceil(now / 300000) * 300000;
    const wait = (nextBar - now) + 8000;   // 8s past the close, so it is settled
    setTimeout(() => { if (state.mode === 'live') refresh(); scheduleNextPoll(); }, wait);
  };
  scheduleNextPoll();
  window.addEventListener('resize', () => drawChart(state.lastAnalysis));
}

boot();
