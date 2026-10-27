/**
 * Booking emails, sent free from your own Gmail.
 *
 * Every 10 minutes this asks the booking database for emails that need
 * sending, sends them from this Gmail account, and reports back which ones went:
 *   - to clients: confirmations, deposit requests, "you're confirmed",
 *     reminders, "your booking has changed" and cancellations;
 *   - to you: alerts when a client books, changes or cancels online.
 *
 * SET-UP (once) — full steps are in SETUP.md, section "Emails":
 *   1. script.google.com → New project → paste this whole file over Code.gs.
 *   2. Project Settings (cog) → Script Properties → add three properties:
 *        SUPABASE_URL       e.g. https://abcdefgh.supabase.co
 *        SUPABASE_ANON_KEY  the "anon public" key
 *        EMAIL_SECRET       the secret from the app: Settings → Email
 *   3. Back in the editor, choose the function "setup" and press Run.
 *      Google asks for permission to send email as you — allow it. (It uses
 *      MailApp, which can only SEND mail: it cannot read your inbox.)
 *   4. Optional: run "sendTestEmail" to see what clients receive.
 *
 * LIMITS: a personal Gmail account can send about 100 emails a day this way —
 * far more than a one-person diary needs. If a run fails, the emails stay in
 * the queue and are retried on the next run (up to 5 tries).
 */

var POLL_MINUTES = 10;

function setup() {
  var cfg = config_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processEmails') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processEmails').timeBased().everyMinutes(POLL_MINUTES).create();
  // First run straight away, to prove the connection and the secret work.
  var sent = processEmails();
  Logger.log('All set. Checked the booking database for ' + cfg.url + ' — ' + sent + ' email(s) sent. ' +
    'From now on this runs every ' + POLL_MINUTES + ' minutes.');
}

function processEmails() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return 0; // a previous run is still going
  try {
    var cfg = config_();
    var props = PropertiesService.getScriptProperties();
    // Emails sent on an earlier run whose "sent" report never reached the
    // database (network blip, run cut short). Remembered here so they are
    // reported as sent rather than sent twice.
    var unreported = JSON.parse(props.getProperty('SENT_UNREPORTED') || '{}');
    var quota = MailApp.getRemainingDailyQuota();
    var claim = rpc_(cfg, 'email_jobs_claim', { p_secret: cfg.secret, p_limit: Math.max(0, Math.min(quota, 50)) });
    var s = claim.settings || {};
    var me = (Session.getEffectiveUser().getEmail() || '').toLowerCase();
    var results = [];
    var sent = 0;
    (claim.jobs || []).forEach(function (job) {
      if (unreported[job.id]) { results.push({ id: job.id, ok: true }); return; }
      try {
        var msg = render_(job, s);
        var options = { htmlBody: msg.html, name: s.business_name || 'Bookings' };
        // Replies go to the owner. Only set Reply-To when it differs from this
        // Gmail account: a needless Reply-To to another free-mail address is a spam signal.
        // Her own alerts (owner_*) reply straight to the client instead.
        if (/^owner_/.test(job.kind)) {
          if (job.client_email) options.replyTo = job.client_email;
        } else if (s.owner_email && s.owner_email.toLowerCase() !== me) {
          options.replyTo = s.owner_email;
        }
        MailApp.sendEmail(job.to, msg.subject, msg.text, options);
        unreported[job.id] = true;
        props.setProperty('SENT_UNREPORTED', JSON.stringify(unreported));
        results.push({ id: job.id, ok: true });
        sent++;
      } catch (e) {
        results.push({ id: job.id, ok: false, error: String((e && e.message) || e) });
      }
    });
    if (results.length) {
      reportWithRetry_(cfg, results);
      // Reported: forget them. (Anything not in this batch is kept for next time.)
      results.forEach(function (r) { delete unreported[r.id]; });
      props.setProperty('SENT_UNREPORTED', JSON.stringify(unreported));
    }
    return sent;
  } finally {
    lock.releaseLock();
  }
}

function reportWithRetry_(cfg, results) {
  for (var attempt = 1; ; attempt++) {
    try {
      return rpc_(cfg, 'email_jobs_report', { p_secret: cfg.secret, p_results: results });
    } catch (e) {
      if (attempt >= 3) throw e;
      Utilities.sleep(2000 * attempt);
    }
  }
}

/** Sends you a sample deposit-request email so you can see what clients get. */
function sendTestEmail() {
  var me = Session.getActiveUser().getEmail();
  var start = new Date(Date.now() + 5 * 86400000);
  var msg = render_({
    kind: 'booking_received', status: 'pending_deposit', first_name: 'Jess', client_name: 'Jess Example',
    service_name: 'BIAB new set', price_pence: 3500, starts_at: start.toISOString(), reference: 'K3Q7XP',
    deposit_required_pence: 1000, deposit_due_at: new Date(Date.now() + 86400000).toISOString(),
    form_needed: true, form_url: 'https://example.com/form/test', manage_url: 'https://example.com/manage/test',
    free_until: new Date(start.getTime() - 48 * 3600000).toISOString(),
  }, {
    business_name: 'Your Nail Studio', timezone: 'Europe/London', bank_account_name: 'Your Name',
    bank_sort_code: '00-00-00', bank_account_number: '12345678', address: '1 Example Road',
    cancellation_policy: 'Please give at least 48 hours’ notice if you need to cancel or move your appointment. ' +
      'If you cancel with less than 48 hours’ notice, or don’t turn up, the full price of your treatment is payable.',
    cancel_notice_hours: 48, client_self_service: true, public_site_url: 'https://example.com',
  });
  MailApp.sendEmail(me, '[TEST] ' + msg.subject, msg.text, { htmlBody: msg.html });
  Logger.log('Test email sent to ' + me);
}

// ---------------------------------------------------------------------------

function config_() {
  var p = PropertiesService.getScriptProperties();
  var url = (p.getProperty('SUPABASE_URL') || '').trim().replace(/\/+$/, '');
  var key = (p.getProperty('SUPABASE_ANON_KEY') || '').trim();
  var secret = (p.getProperty('EMAIL_SECRET') || '').trim();
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) throw new Error('Script property SUPABASE_URL is missing or not a supabase.co address.');
  if (!key) throw new Error('Script property SUPABASE_ANON_KEY is missing.');
  if (!secret) throw new Error('Script property EMAIL_SECRET is missing — create it in the app: Settings → Email.');
  return { url: url, key: key, secret: secret };
}

function rpc_(cfg, fn, body) {
  var headers = { apikey: cfg.key };
  // Older "anon" keys are JWTs and also go in Authorization; the newer
  // "sb_publishable_…" keys belong in the apikey header only.
  if (/^eyJ/.test(cfg.key)) headers.Authorization = 'Bearer ' + cfg.key;
  var res = UrlFetchApp.fetch(cfg.url + '/rest/v1/rpc/' + fn, {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code < 200 || code >= 300) {
    if (text.indexOf('unauthorized') >= 0) throw new Error('The database refused the EMAIL_SECRET. Make a new one in the app (Settings → Email) and paste it into Script Properties.');
    throw new Error('Database call ' + fn + ' failed (' + code + '): ' + text.slice(0, 300));
  }
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------
// Email wording
// ---------------------------------------------------------------------------

function render_(job, s) {
  var tz = s.timezone || 'Europe/London';
  var when = fmt_(job.starts_at, tz, "EEEE d MMMM 'at' HH:mm");
  var biz = s.business_name || 'Bookings';
  var details = [
    ['Treatment', job.service_name],
    ['When', when],
    ['Price', money_(job.price_pence)],
    ['Reference', job.reference],
  ];
  var site = (s.public_site_url || '').replace(/\/+$/, '');
  var policy = s.cancellation_policy ? p_('<b>Cancellations:</b> ' + esc_(s.cancellation_policy)) : '';
  var contact = s.owner_phone ? p_('Questions? Reply to this email or WhatsApp ' + esc_(s.owner_phone) + '.') : p_('Questions? Just reply to this email.');
  var formBlock = job.form_needed && job.form_url
    ? box_('<b>Before your first visit</b><br>Please fill in this quick health and allergy form (2 minutes): <br>' + link_(job.form_url, 'Open the consultation form'))
    : '';
  var address = s.address ? ['Where', s.address] : null;
  // The notice the cancellation policy asks for: "48 hours" / "less than 48 hours’ notice" /
  // "with less than 48 hours’ notice". 0 means no notice period, so the policy is off; anything
  // flagged late before she set it is "short notice", never "0 hours".
  var noticeHours = s.cancel_notice_hours === null || s.cancel_notice_hours === undefined ? 48 : Number(s.cancel_notice_hours);
  var hrs = noticeHours === 1 ? '1 hour' : noticeHours + ' hours';
  var lessThan = noticeHours > 0 ? 'less than ' + (noticeHours === 1 ? '1 hour’s notice' : noticeHours + ' hours’ notice') : 'short notice';
  var withNotice = noticeHours > 0 ? 'with ' + lessThan : 'at short notice';
  // Only ever in emails to the client: the link is the key to their booking.
  var manage = manageBlock_(job, s, tz, noticeHours, withNotice);
  var diary = site ? p_(link_(site + '/', 'Open your diary')) : '';

  // --- Alerts to the owner (never the client's change/cancel link) ----------

  if (job.kind === 'owner_new_booking') {
    var rows = clientRows_(job).concat([
      ['Treatment', job.service_name], ['When', when], ['Reference', job.reference],
      ['Status', job.status === 'pending_deposit' ? 'New client — waiting for ' + money_(job.deposit_required_pence) + ' deposit' : 'Confirmed (returning client)'],
    ]);
    if (job.client_notes) rows.push(['Their note', job.client_notes]);
    return msg_('New booking: ' + job.client_name + ' — ' + job.service_name + ', ' + fmt_(job.starts_at, tz, 'EEE d MMM HH:mm'),
      'New online booking', [table_(rows), diary], biz);
  }

  if (job.kind === 'owner_changed') {
    var changes = job.changes || [];
    var anyLate = changes.some(function (x) { return x.late; });
    var current = clientRows_(job).concat([
      ['Treatment', job.service_name], ['When', when], ['Price', money_(job.price_pence)], ['Reference', job.reference],
      ['Status', job.status === 'pending_deposit' ? 'Waiting for ' + money_(job.deposit_required_pence) + ' deposit' : 'Confirmed'],
    ]);
    return msg_('Booking changed: ' + job.client_name + ' — ' + job.service_name + ', ' + fmt_(job.starts_at, tz, 'EEE d MMM HH:mm'),
      'A client changed their booking',
      [
        p_(esc_(job.client_name) + ' changed their booking online. It’s now:'),
        table_(current),
        // A move or a switch of treatment: either counts once it's inside the notice period.
        anyLate ? box_('<b>Changed ' + esc_(withNotice) + '.</b>') : '',
        changes.length ? p_('<b>What changed</b>') : '',
        changes.length ? changeList_(changes, tz, noticeHours, lessThan) : '',
        diary,
      ], biz);
  }

  if (job.kind === 'owner_cancelled') {
    var late = !!job.cancelled_late;
    var deposit = job.deposit_required_pence > 0
      ? money_(job.deposit_required_pence) + (job.deposit_paid ? ' — paid' : ' — not paid')
      : 'None';
    var gone = clientRows_(job).concat([
      ['Treatment', job.service_name], ['Was', when], ['Price', money_(job.price_pence)], ['Reference', job.reference],
      ['Deposit', deposit],
    ]);
    if (job.cancel_reason) gone.push(['Their reason', job.cancel_reason]);
    // What the policy charges: the price it had when they first changed it
    // late, if that was more than it is now (a cheaper treatment since).
    var fee = job.late_fee_pence || job.price_pence;
    var full = fee > 0 ? 'the full ' + money_(fee) + (fee > job.price_pence ? ' (the price before they changed it)' : '') : 'the full price';
    var payable = ' is payable — this is for you to arrange with the client; the app doesn’t take payments.';
    // A late change followed by a cancellation in good time counts as late too (see
    // public_cancel_booking). One that wasn't counted (an older booking) still deserves a mention.
    var changedLate = (job.changes || []).some(function (x) { return x.late && x.action !== 'cancelled'; });
    var lateBox = !late ? ''
      : lateFromEarlierChange_(job)
        ? box_('<b>They changed this booking ' + esc_(withNotice) + ' earlier</b>, so this cancellation counts as late under your policy. ' +
            full.charAt(0).toUpperCase() + full.slice(1) + payable)
        : box_('<b>Cancelled ' + esc_(withNotice) + '.</b> Under your cancellation policy ' + full + payable);
    // A paid deposit counts towards a late fee (as the app's balance does); otherwise what
    // happens to it is up to her.
    var paidDeposit = !job.deposit_paid ? ''
      : late
        ? p_('They paid a ' + money_(job.deposit_required_pence) + ' deposit, which counts towards it, so the balance is ' +
            money_(Math.max(0, fee - job.deposit_required_pence)) + '.')
        : p_('They paid a ' + money_(job.deposit_required_pence) + ' deposit. Whether you keep it or refund it is your call.');
    return msg_((late ? 'Late cancellation: ' : 'Cancelled: ') + job.client_name + ' — ' + job.service_name + ', ' + fmt_(job.starts_at, tz, 'EEE d MMM HH:mm'),
      late ? 'Late cancellation' : 'A client cancelled',
      [
        p_(esc_(job.client_name) + ' cancelled their booking online. The time is free again in your diary.'),
        table_(gone),
        lateBox,
        !late && changedLate ? box_('Earlier, they changed this booking ' + esc_(withNotice) + '.') : '',
        paidDeposit,
        diary,
      ], biz);
  }

  // --- Emails to the client --------------------------------------------------

  if (job.kind === 'booking_received' && job.status === 'pending_deposit') {
    return msg_('Please pay your deposit to secure your booking — ' + biz,
      'Thanks for booking, ' + esc_(job.first_name) + '!',
      depositBlocks_(job, s, tz, 'Your appointment is reserved. ').concat([table_(details), formBlock, manage, policy, contact]), biz);
  }

  if (job.kind === 'booking_received' || job.kind === 'deposit_received') {
    var confirmed = address ? details.concat([address]) : details;
    var intro = job.kind === 'deposit_received'
      ? 'Your deposit has arrived — thank you! Your appointment is confirmed.'
      : 'You’re booked in. Here are your details:';
    return msg_((job.kind === 'deposit_received' ? 'Deposit received — you’re confirmed' : 'You’re booked in') + ': ' + job.service_name + ', ' + fmt_(job.starts_at, tz, 'EEE d MMM'),
      'See you soon, ' + esc_(job.first_name) + '!', [p_(intro), table_(confirmed), formBlock, manage, policy, contact], biz);
  }

  if (job.kind === 'reminder') {
    var r = address ? details.concat([address]) : details;
    return msg_('Reminder: ' + job.service_name + ' on ' + fmt_(job.starts_at, tz, "EEEE 'at' HH:mm"),
      'See you soon, ' + esc_(job.first_name) + '!',
      [p_('Just a reminder of your appointment:'), table_(r), formBlock, manage, policy, contact], biz);
  }

  if (job.kind === 'changed') {
    var owing = job.status === 'pending_deposit' && !job.deposit_paid;
    // The address only goes to confirmed bookings, as in the confirmation itself.
    var updated = address && job.status === 'confirmed' ? details.concat([address]) : details;
    return msg_('Your booking has changed: ' + job.service_name + ', ' + fmt_(job.starts_at, tz, 'EEE d MMM'),
      'Your booking has changed',
      [p_('Hi ' + esc_(job.first_name) + ', here are your new booking details:'), table_(updated)]
        .concat(owing ? depositBlocks_(job, s, tz, 'Your appointment is still reserved. ') : [])
        .concat([formBlock, manage, policy, contact]), biz);
  }

  if (job.kind === 'cancelled') {
    var c = [['Treatment', job.service_name], ['Was', when], ['Reference', job.reference]];
    var blocks;
    var byClient = job.cancelled_by === 'client';
    if (byClient) {
      // They wrote the reason themselves, so it isn't repeated back to them.
      blocks = [p_('Hi ' + esc_(job.first_name) + ', as you asked, your appointment below has been cancelled.'), table_(c)];
    } else {
      if (job.cancel_reason) c.push(['Reason', job.cancel_reason]);
      blocks = [p_('Hi ' + esc_(job.first_name) + ', your appointment below has been cancelled.'), table_(c)];
    }
    // Late online, or the owner cancelled on the client's behalf and marked it late.
    if (job.cancelled_late && (byClient || job.cancelled_by === 'owner')) {
      // Late because of an earlier change inside the notice period, not because of when it was cancelled.
      var why = lateFromEarlierChange_(job)
        ? (byClient ? 'As you changed this booking ' : 'As this booking was changed ') + withNotice
        : noticeHours > 0 ? 'As this was less than ' + hrs + ' before your appointment' : 'As this was cancelled at short notice';
      blocks.push(p_(esc_(why) + ', our cancellation policy applies' + (s.cancellation_policy ? ': ' + esc_(s.cancellation_policy) : '.')));
      // The fee is fixed at the dearest price it had when it was changed or cancelled late.
      var owed = job.late_fee_pence || job.price_pence;
      if (owed > 0) {
        blocks.push(p_('The full ' + money_(owed) + ' is payable' +
          (owed > job.price_pence ? ' (the price of your booking before you changed it)' : '') + '.'));
      }
    }
    return msg_('Your appointment has been cancelled — ' + biz, 'Appointment cancelled',
      blocks.concat([site ? p_('To book a new time: ' + link_(site + '/book', site + '/book')) : '', contact]), biz);
  }

  throw new Error('Unknown email kind: ' + job.kind);
}

/** Client, (booked as), mobile (and the one given when booking) and email rows for the owner's alerts. */
function clientRows_(job) {
  var rows = [['Client', job.client_name]];
  if (job.booking_name && job.booking_name !== job.client_name) rows.push(['Booked as', job.booking_name]);
  rows.push(['Mobile', job.client_phone || '—']);
  // A returning client typed a different mobile when booking. Her record is
  // never changed from the booking page, so reminders still go to the old one.
  if (job.booking_phone) {
    rows.push(['Mobile given', job.booking_phone + (job.client_phone
      ? ' (different from their record — check before you WhatsApp)'
      : ' (not on their record — check it before you add it)')]);
  }
  rows.push(['Email', job.client_email || '—']);
  return rows;
}

/**
 * A late cancellation made in good time for the booking's current slot: it
 * counts as late because they changed it inside the notice period earlier.
 * (No notice period means no free_until, so never.)
 */
function lateFromEarlierChange_(job) {
  return !!job.cancelled_late && !!job.cancelled_at && !!job.free_until &&
    new Date(job.cancelled_at).getTime() < new Date(job.free_until).getTime();
}

/** The deposit request and bank details, for a booking still waiting for its deposit. */
function depositBlocks_(job, s, tz, lead) {
  var bank = [
    ['Amount', money_(job.deposit_required_pence)],
    ['Account name', s.bank_account_name || ''],
    ['Sort code', s.bank_sort_code || ''],
    ['Account number', s.bank_account_number || ''],
    ['Reference', job.reference],
  ];
  // A deadline that has already passed (a re-sent email) isn't repeated back.
  var due = job.deposit_due_at && new Date(job.deposit_due_at).getTime() > Date.now()
    ? 'by ' + fmt_(job.deposit_due_at, tz, "HH:mm 'on' EEEE d MMMM") : 'as soon as you can';
  return [
    p_(lead + 'As a new client, please pay a <b>' + money_(job.deposit_required_pence) + ' deposit</b> by bank transfer ' + esc_(due) + ' to secure it. It comes off your bill on the day.'),
    box_(table_(bank)),
    p_('Please use the reference <b>' + esc_(job.reference) + '</b> so your payment can be matched. You’ll get another email once it has arrived.'),
  ];
}

/**
 * "Need to change or cancel?" with the client's own link, and the time after
 * which the cancellation policy applies. Only for emails to the client.
 */
function manageBlock_(job, s, tz, noticeHours, withNotice) {
  var online = s.client_self_service !== false && /^https:\/\//i.test(job.manage_url || '');
  // Once they've changed it inside the notice period, a cancellation is late
  // whenever it comes, so there's no "free until" time to offer any more.
  // With no notice period (0) the policy is off, so that no longer applies.
  var lateChange = noticeHours > 0 && job.late_fee_pence !== null && job.late_fee_pence !== undefined;
  var by = lateChange
    ? 'As you changed this booking ' + withNotice + ', the cancellation policy applies if you cancel.'
    : job.free_until && new Date(job.free_until).getTime() > Date.now()
      ? 'Please let us know by ' + fmt_(job.free_until, tz, "EEEE d MMMM 'at' HH:mm") + ' — after that, the cancellation policy applies.'
      : '';
  if (!online && !by) return '';
  return p_('Need to change or cancel? ' +
    (online ? 'You can do it online: ' + link_(job.manage_url, 'Change or cancel your booking') : 'Just get in touch.') +
    (by ? '<br>' + esc_(by) : ''));
}

/** The client's recent online changes, oldest first, for the owner. lessThan: "less than 48 hours’ notice". */
function changeList_(changes, tz, noticeHours, lessThan) {
  var moved = function (x) { return 'from ' + fmt_(x.old_starts_at, tz, 'EEE d MMM HH:mm') + ' to ' + fmt_(x.new_starts_at, tz, 'EEE d MMM HH:mm'); };
  var switched = function (x) { return 'from ' + x.old_service_name + ' to ' + x.new_service_name; };
  // A cancellation made before its own cut-off is late only because of an earlier change.
  var inTime = function (x) {
    return x.action === 'cancelled' && noticeHours > 0 && !!x.at && !!x.old_starts_at &&
      new Date(x.at).getTime() < new Date(x.old_starts_at).getTime() - noticeHours * 3600000;
  };
  return '<ul style="margin:6px 0;padding-left:20px">' + changes.map(function (x) {
    var what = x.action === 'moved' ? 'Moved ' + moved(x)
      : x.action === 'treatment' ? 'Switched ' + switched(x)
      : x.action === 'moved_treatment' ? 'Moved ' + moved(x) + ', and switched ' + switched(x)
      : 'Cancelled';
    var late = !x.late ? '' : inTime(x) ? 'counts as late: changed with ' + lessThan + ' earlier' : lessThan;
    return '<li style="margin:3px 0">' + esc_(what) + (late ? ' <b>(' + esc_(late) + ')</b>' : '') +
      ' <span style="color:#76676b">· changed ' + esc_(fmt_(x.at, tz, "EEE d MMM 'at' HH:mm")) + '</span></li>';
  }).join('') + '</ul>';
}

// ---------------------------------------------------------------------------
// Small helpers. Everything a client typed is HTML-escaped before use.
// ---------------------------------------------------------------------------

function msg_(subject, heading, blocks, biz) {
  var html =
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#2a2224;line-height:1.5">' +
    '<h2 style="margin:0 0 12px;font-size:20px">' + heading + '</h2>' +
    blocks.filter(Boolean).join('') +
    '<p style="color:#76676b;font-size:13px;margin-top:24px">' + esc_(biz) + '</p></div>';
  var text = stripHtml_(heading) + '\n\n' +
    blocks.filter(Boolean).map(function (b) { return stripHtml_(b); }).join('\n\n') + '\n\n' + biz;
  return { subject: subject, html: html, text: text };
}

function table_(rows) {
  return '<table style="border-collapse:collapse;margin:8px 0">' + rows.map(function (r) {
    return '<tr><td style="padding:3px 14px 3px 0;color:#76676b;vertical-align:top">' + esc_(r[0]) +
      '</td><td style="padding:3px 0;vertical-align:top">' + esc_(r[1]).replace(/\n/g, '<br>') + '</td></tr>';
  }).join('') + '</table>';
}
function p_(html) { return '<p style="margin:10px 0">' + html + '</p>'; }
function box_(html) { return '<div style="background:#f7e3ea;border-radius:12px;padding:12px 14px;margin:12px 0">' + html + '</div>'; }
function link_(url, label) {
  if (!/^https:\/\//i.test(url)) return esc_(label);
  return '<a href="' + esc_(url) + '" style="color:#a8325f">' + esc_(label) + '</a>';
}
function esc_(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function stripHtml_(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/tr>/gi, '\n').replace(/<\/td><td[^>]*>/gi, ': ')
    .replace(/<li[^>]*>/gi, '- ').replace(/<\/li>/gi, '\n')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}
function money_(pence) {
  var n = Number(pence || 0) / 100;
  return '£' + (n % 1 === 0 ? n.toFixed(0) : n.toFixed(2));
}
function fmt_(iso, tz, pattern) {
  return Utilities.formatDate(new Date(iso), tz, pattern);
}
