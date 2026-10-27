# Salon booking app: a free home-screen app for a one-person nail business

A replacement for a paid salon-booking subscription, built for a self-employed nail
technician. It runs as a **home-screen web app on her iPhone** and costs **£0 a month**:
no card processor, no SMS and no paid WhatsApp.

**Set-up instructions are in [SETUP.md](SETUP.md).**

| For clients | For the owner |
|---|---|
| Online booking page for her Instagram bio | **Today**: what's on, deposits waiting, missing forms, what clients changed |
| **Change or cancel online** from a private link, any time before the appointment | **Diary**: week view, add, move and cancel bookings, block time off |
| Health and allergy consultation form for first visits | **One-tap WhatsApp** reminders (3 days ahead) and deposit requests |
| Confirmation, change and reminder emails (72 hours before) | **Late cancellations** flagged, with a one-tap follow-up and "record payment" |
| Bank-transfer deposit instructions (new clients only) | **Clients**: notes, allergies, patch tests, forms, private nail photos |
| Plain-English privacy notice | **Money**: cash and bank-transfer takings, by month or UK tax year, CSV export |

## How it fits together

```
 iPhone home screen ──► web app (React, hosted free on Netlify)
                              │  public key + database rules
                              ▼
                     Supabase (Postgres, London)  ◄── Google Apps Script in her Gmail
                     tables locked down by RLS        polls every 10 min, sends emails
                     public_* functions for booking   (email_jobs_claim / _report + secret)
```

- **`supabase/schema.sql`** is where the rules live: no double bookings (a Postgres exclusion
  constraint that includes the clean-up buffer), deposits only for new clients, opening hours,
  notice periods and time off. It also holds the security model. Every table is owner-only under
  Row Level Security. The public booking page can only call a handful of `public_*` functions, and
  they never reveal who has booked or whether someone is an existing client.
- **`web/`** is the app: Vite, React and TypeScript, installable from the home screen. In
  development, or with `VITE_DEMO=1`, it runs a **demo** on invented data kept in the browser. A
  production build with no database settings refuses to start, so it can't quietly take
  bookings that go nowhere.
- **`apps-script/Code.gs`** sends email from the owner's own Gmail using `MailApp`, which can
  send mail but not read it.

## Decisions worth knowing

- **Deposits by bank transfer, ticked off by hand.** The owner didn't want Stripe or SumUp.
  Each booking has a short reference (`K3Q7XP`) for the transfer, and she marks it received.
  That records the money and emails the client to say they're confirmed.
- **"New client" means no completed appointment.** Someone who booked before but never turned
  up is still asked for a deposit.
- **Clients manage their own booking through a secret link.** Each confirmation, reminder and
  WhatsApp reminder has a `/manage/<token>` link. It opens that one booking and nothing else, and it
  is never shown on the booking page, so booking with somebody else's email doesn't hand you their
  link. Clients can move, switch treatment or cancel at any time before the start. Inside the
  cancellation notice period (48 hours by default) it still goes through, but it's flagged as late
  and the owner is emailed. The app never charges anyone: she collects a late-cancellation fee
  herself and records it. Any change inside the notice period fixes the fee at the price before it,
  and makes a later cancellation late too, so moving late or downgrading can't shrink the charge.
  A new time follows exactly the same rules as a new booking. Each booking can be changed online at
  most 6 times, and changes across all bookings are capped per hour and per day, so the links can't
  be used to burn through the owner's Gmail quota.
- **Reminders 72 hours ahead.** That is a day before the 48-hour cut-off, so a reminder is still
  useful to someone who needs to change. A reminder email isn't sent on top of a change notice
  the client has just had.
- **WhatsApp is one tap, not automatic.** WhatsApp charges businesses per automated message.
  Opening WhatsApp with the message written, and letting her press send, is free and comes from
  her own number.
- **Emails run on a polling script, not a paid email service.** A 10-minute delay on a
  confirmation is acceptable. The script also keeps the free database from pausing. The app shows
  when the script last checked in, so a silent failure gets noticed.
- **The booking page never says "we know you".** Whether someone is a returning client is decided
  in the database and never echoed back, so the page can't be used to test whether a given
  person is her client.
- **Health data needs explicit consent.** Consultation answers are only stored with a ticked
  consent box and a typed signature, which the database enforces.
- **Tax records survive client deletion.** Deleting a client (the right to erasure) removes their
  details, forms, patch tests and photos, but keeps a name on payments already received, because
  HMRC requires five years of records.

## Running it locally

```bash
cd web
npm install
npm run dev          # demo mode at http://localhost:5173 (no setup needed)
```

To run against a real Supabase project, copy `.env.example` to `.env.local` and fill in the two values.

## Tests

| Command | What it proves |
|---|---|
| `npm run test:db` | The real schema on a local PostgreSQL, acting as the public, the owner and the email script. It covers privacy (the public key reads nothing), double booking and the buffer, deposits for new clients only, time rules, consent, the email queue, and the actual Apps Script code run against the database. |
| `npm test` | Slot calculation, including the BST/GMT changeover, plus UK phone numbers, money, tax years, CSV injection protection and message templates. |
| `npm run test:e2e` | The demo app in Chromium on an iPhone-sized screen. A new client books, fills in the form and gets their deposit confirmed. It also covers returning clients, WhatsApp links, checkout, double-booking refusal, client records, takings export, settings and time off. |

`test:db` needs a local PostgreSQL 15+ that the current OS user can connect to. `test:e2e` needs
Chromium; set `CHROME_PATH` if it isn't at the default path in `playwright.config.ts`.

## What it does not do

No card payments (so no automatic late-cancellation charges), no automatic WhatsApp or SMS, no
marketplace listing, no push notifications (new bookings and changes arrive by email), no expenses
tracking, and one staff member only. The full list, and the reasons, are in [SETUP.md](SETUP.md#what-this-app-does-not-do).
