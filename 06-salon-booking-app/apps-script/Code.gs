/**
 * Booking emails, sent free from your own Gmail.
 *
 * Every 10 minutes this asks the booking database for emails that need
 * sending (confirmations, deposit requests, "you're confirmed", reminders,
 * cancellations and your new-booking alerts), sends them from this Gmail
 * account, and reports back which ones went.
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
    var claim = rpc_(cfg, 'email_jobs_claim', { p_secret: cfg.secret });
    var s = claim.settings || {};
    var results = [];
    var sent = 0;
    (claim.jobs || []).forEach(function (job) {
      try {
        var msg = render_(job, s);
        var options = { htmlBody: msg.html, name: s.business_name || 'Bookings' };
        if (s.owner_email && job.kind !== 'owner_new_booking') options.replyTo = s.owner_email;
        MailApp.sendEmail(job.to, msg.subject, msg.text, options);
        results.push({ id: job.id, ok: true });
        sent++;
      } catch (e) {
        results.push({ id: job.id, ok: false, error: String((e && e.message) || e) });
      }
    });
    if (results.length) rpc_(cfg, 'email_jobs_report', { p_secret: cfg.secret, p_results: results });
    return sent;
  } finally {
    lock.releaseLock();
  }
}

/** Sends you a sample deposit-request email so you can see what clients get. */
function sendTestEmail() {
  var me = Session.getActiveUser().getEmail();
  var start = new Date(Date.now() + 3 * 86400000);
  var msg = render_({
    kind: 'booking_received', status: 'pending_deposit', first_name: 'Jess', client_name: 'Jess Example',
    service_name: 'BIAB new set', price_pence: 3500, starts_at: start.toISOString(), reference: 'K3Q7XP',
    deposit_required_pence: 1000, deposit_due_at: new Date(Date.now() + 86400000).toISOString(),
    form_needed: true, form_url: 'https://example.com/form/test',
  }, {
    business_name: 'Your Nail Studio', timezone: 'Europe/London', bank_account_name: 'Your Name',
    bank_sort_code: '00-00-00', bank_account_number: '12345678', address: '1 Example Road',
    cancellation_policy: 'Please give 24 hours’ notice to cancel.', public_site_url: 'https://example.com',
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
  var res = UrlFetchApp.fetch(cfg.url + '/rest/v1/rpc/' + fn, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key },
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

  if (job.kind === 'owner_new_booking') {
    var rows = [
      ['Client', job.client_name], ['Mobile', job.client_phone || '—'], ['Email', job.client_email || '—'],
      ['Treatment', job.service_name], ['When', when], ['Reference', job.reference],
      ['Status', job.status === 'pending_deposit' ? 'New client — waiting for ' + money_(job.deposit_required_pence) + ' deposit' : 'Confirmed (returning client)'],
    ];
    if (job.client_notes) rows.push(['Their note', job.client_notes]);
    return msg_('New booking: ' + job.client_name + ' — ' + job.service_name + ', ' + fmt_(job.starts_at, tz, 'EEE d MMM HH:mm'),
      'New online booking', [table_(rows), site ? p_(link_(site + '/', 'Open your diary')) : ''], biz);
  }

  if (job.kind === 'booking_received' && job.status === 'pending_deposit') {
    var bank = [
      ['Amount', money_(job.deposit_required_pence)],
      ['Account name', s.bank_account_name || ''],
      ['Sort code', s.bank_sort_code || ''],
      ['Account number', s.bank_account_number || ''],
      ['Reference', job.reference],
    ];
    var due = job.deposit_due_at ? fmt_(job.deposit_due_at, tz, "EEEE d MMMM 'by' HH:mm") : 'as soon as you can';
    return msg_('Please pay your deposit to secure your booking — ' + biz,
      'Thanks for booking, ' + esc_(job.first_name) + '!',
      [
        p_('Your appointment is reserved. As a new client, please pay a <b>' + money_(job.deposit_required_pence) + ' deposit</b> by bank transfer on ' + esc_(due) + ' to secure it. It comes off your bill on the day.'),
        box_(table_(bank)),
        p_('Please use the reference <b>' + esc_(job.reference) + '</b> so your payment can be matched. You’ll get another email once it has arrived.'),
        table_(details), formBlock, policy, contact,
      ], biz);
  }

  if (job.kind === 'booking_received' || job.kind === 'deposit_received') {
    var confirmed = address ? details.concat([address]) : details;
    var intro = job.kind === 'deposit_received'
      ? 'Your deposit has arrived — thank you! Your appointment is confirmed.'
      : 'You’re booked in. Here are your details:';
    return msg_((job.kind === 'deposit_received' ? 'Deposit received — you’re confirmed' : 'You’re booked in') + ': ' + job.service_name + ', ' + fmt_(job.starts_at, tz, 'EEE d MMM'),
      'See you soon, ' + esc_(job.first_name) + '!', [p_(intro), table_(confirmed), formBlock, policy, contact], biz);
  }

  if (job.kind === 'reminder') {
    var r = address ? details.concat([address]) : details;
    return msg_('Reminder: ' + job.service_name + ' on ' + fmt_(job.starts_at, tz, "EEEE 'at' HH:mm"),
      'See you soon, ' + esc_(job.first_name) + '!',
      [p_('Just a reminder of your appointment:'), table_(r), formBlock, policy, contact], biz);
  }

  if (job.kind === 'cancelled') {
    var c = [['Treatment', job.service_name], ['Was', when], ['Reference', job.reference]];
    if (job.cancel_reason) c.push(['Reason', job.cancel_reason]);
    return msg_('Your appointment has been cancelled — ' + biz, 'Appointment cancelled',
      [p_('Hi ' + esc_(job.first_name) + ', your appointment below has been cancelled.'), table_(c),
        site ? p_('To book a new time: ' + link_(site + '/book', site + '/book')) : '', contact], biz);
  }

  throw new Error('Unknown email kind: ' + job.kind);
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
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}
function money_(pence) {
  var n = Number(pence || 0) / 100;
  return '£' + (n % 1 === 0 ? n.toFixed(0) : n.toFixed(2));
}
function fmt_(iso, tz, pattern) {
  return Utilities.formatDate(new Date(iso), tz, pattern);
}
