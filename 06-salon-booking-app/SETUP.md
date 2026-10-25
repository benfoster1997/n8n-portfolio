# Setting up the booking app

This guide gets the app live for one nail business, for **£0 a month**. It takes about
**45 minutes** at a computer, plus five minutes on the iPhone. Nothing here needs
coding: it is clicking, copying and pasting.

You will create three free accounts. Use the business's own email for all of them,
so everything belongs to the business owner rather than to whoever sets it up.

| Service | What it does | Cost |
|---|---|---|
| **Supabase** | The private database: bookings, clients, forms, photos, takings | Free plan |
| **Netlify** | Puts the app on the web at an address like `yourname.netlify.app` | Free plan |
| **Google Apps Script** (in her Gmail) | Sends confirmation and reminder emails from her own Gmail | Free |

> **Before you start:** a business that keeps client records on a computer or phone
> normally has to pay the **ICO data protection fee** (£52 a year for a small business,
> £47 by direct debit). This is a legal requirement whatever app is used, so
> she may already pay it. Check at [ico.org.uk/fee](https://ico.org.uk/for-organisations/data-protection-fee/).

---

## 1. Create the database (Supabase) — 15 minutes

1. Go to [supabase.com](https://supabase.com) → **Start your project** → sign up with the business email.
2. **New project**:
   - Name: `bookings`
   - Database password: press **Generate a password** and save it in a password manager. You will rarely need it.
   - **Region: West EU (London)** ← important, so client data stays in the UK.
   - Plan: **Free**.
3. Wait a minute or two while it sets up.
4. Left menu → **SQL Editor** → **New query**. Open [`supabase/schema.sql`](supabase/schema.sql),
   copy **all** of it, paste it in and press **Run**. It should say *Success. No rows returned*.
5. **New query** again. Paste all of [`supabase/storage.sql`](supabase/storage.sql) and press **Run**.
6. Left menu → **Project Settings** → **API** (sometimes called **Data API** / **API Keys**). Copy two things into a note:
   - **Project URL**, e.g. `https://abcdefghijkl.supabase.co`
   - **anon / public** key, a long string. If you see a *publishable* key (`sb_publishable_…`) that works too.

   ⚠️ Never use the **service_role** / **secret** key anywhere in this app. It skips every privacy rule.

---

## 2. Put the app online (Netlify) — 10 minutes

1. Go to [netlify.com](https://www.netlify.com) → sign up (the free plan allows business use).
2. **Add new site → Import an existing project → GitHub**, and pick this repository.
3. Settings:
   - **Base directory:** `06-salon-booking-app/web`
   - **Build command:** `npm run build` (filled in automatically from `netlify.toml`)
   - **Publish directory:** `dist`
4. **Environment variables → Add**:
   - `VITE_SUPABASE_URL` = the Project URL from step 1.6
   - `VITE_SUPABASE_ANON_KEY` = the anon key from step 1.6
5. **Deploy**. After a minute you get an address like `random-name-123.netlify.app`.
6. **Site configuration → Change site name** to something tidy, e.g. `yourstudio` → `https://yourstudio.netlify.app`.
7. Back in **Supabase → Authentication → URL Configuration**:
   - **Site URL:** your Netlify address, e.g. `https://yourstudio.netlify.app`
   - **Redirect URLs → Add:** `https://yourstudio.netlify.app/**`

   This makes the "confirm your email" and "reset password" links open the app.

> If you skip the environment variables, the site still works, but in **demo mode** with
> invented data. That's a handy way to look around first.

---

## 3. Create her owner account — 5 minutes (on her iPhone)

1. On the iPhone, open **Safari** and go to the Netlify address.
2. Tap **First time here? Create the owner account**. Enter her email and a strong password of 10+ characters.
3. Open the confirmation email from Supabase and tap the link. Then sign in.
4. **The first account created becomes the owner.** Straight after this, lock the door:
   **Supabase → Authentication → Sign In / Providers** (or **Settings**) → turn **off**
   **"Allow new users to sign up"** → Save. Even if someone else did sign up,
   they would see nothing, but this stops strangers making accounts at all.

---

## 4. Add it to the home screen — 1 minute

In Safari on the iPhone: tap **Share** (the square with the arrow) → **Add to Home Screen**
→ name it **Bookings** → **Add**. It now opens full-screen like an app, with its own icon.
She stays signed in.

---

## 5. Fill in her details in the app — 10 minutes

Open the app → **Settings**:

1. **Business details**:
   - Name, a line of welcome text, and the area (shown publicly). The full address only goes into confirmation emails.
   - Her email, so new-booking alerts reach her.
   - Her mobile (optional).
   - **This app's web address**: tap *Use …netlify.app*.
2. **Opening hours**: the days and times clients can book, and any lunch break.
3. **Treatments & prices**: add each service with how long it really takes, including removal.
4. **Deposits & bank details**:
   - The deposit for new clients (e.g. £10), and how many hours they have to pay.
   - Account name, sort code and account number. These are only ever sent to clients who owe a deposit.
   - Her cancellation policy.
5. **Booking rules**:
   - The gap between clients (clean-up time), defaulting to 10 minutes.
   - The minimum notice (default 12 hours) and how far ahead people can book (default 60 days).
6. **WhatsApp messages**: optional. Edit the wording of the reminder, deposit and confirmation messages.

The **Today** screen shows a "Finish setting up" list until the essentials are done.

---

## 6. Switch on emails (Google Apps Script) — 10 minutes

This sends confirmation, deposit, reminder and cancellation emails **from her own Gmail**, free.
It uses Google's MailApp, which can *send* email but **cannot read her inbox**.

1. In the app: **Settings → Email confirmations & reminders → Create the secret**.
   Copy the secret now. It's shown once. Leave this page open: it also shows the URL and key to copy.
2. On a computer, signed in to **her** Google account, go to [script.google.com](https://script.google.com) → **New project**.
   Name it `Booking emails`.
3. Delete what's in `Code.gs`, then paste in **all** of [`apps-script/Code.gs`](apps-script/Code.gs). Press **Save** 💾.
4. **Project Settings** (cog, left) → **Script Properties → Add script property** three times:

   | Property | Value |
   |---|---|
   | `SUPABASE_URL` | the Project URL |
   | `SUPABASE_ANON_KEY` | the anon key |
   | `EMAIL_SECRET` | the secret from step 1 |

5. Back to **Editor** (`< >`). In the function dropdown at the top choose **`setup`** → **Run**.
   Google asks for permission:
   - **Review permissions** → choose her account.
   - "Google hasn't verified this app" appears because it's her own script. Tap **Advanced → Go to Booking emails** → **Allow**.
6. The log should end with *All set…*. Optional: choose **`sendTestEmail`** → **Run** to see a sample deposit email in her inbox.
7. In the app, **Settings → Email** should now say *Email sender last checked in … — working.*

From now on it runs every 10 minutes by itself, even with the computer off. A personal
Gmail can send about 100 emails a day this way, which is plenty for one person.

> The email script checking in every 10 minutes also keeps the free Supabase project
> awake. Free projects pause after a week with no activity.

---

## 7. Share the booking link

Her booking page is `https://YOUR-SITE.netlify.app/book`. The **Today** screen has a **Share link** button.
- **Instagram:** Edit profile → Links → add it.
- **WhatsApp Business:** Settings → Business tools → Profile → Website.
- **Google Business Profile:** Edit profile → Booking link.

---

## 8. Moving across from Fresha

1. In Fresha, **export her client list** (Clients → Export) and note all future appointments.
2. Add upcoming appointments in the new app: **Diary → +** (search or add the client, pick the time, untick the deposit).
   Clients with an email can be sent a confirmation from the new app.
3. Swap the booking link on Instagram and WhatsApp to the new one.
4. Keep Fresha running until every Fresha booking has happened, then cancel the subscription.

Clients found through Fresha's marketplace won't find her there any more. New clients now come
from her own Instagram, WhatsApp, Google profile and word of mouth.

---

## Day to day

| She wants to… | Where |
|---|---|
| See today and anything waiting on her | **Today** |
| Send tomorrow's WhatsApp reminders | **Today → Send N WhatsApp reminders**: tap each one, WhatsApp opens with the message written, press send |
| Confirm a new client's deposit has arrived | Today → *Deposits waiting* → the booking → **Deposit received** (the client is emailed automatically) |
| Finish an appointment and record payment | The appointment → **Finish & take payment** → cash or bank transfer |
| Block a holiday or a dentist appointment | **Diary → Block time** |
| See a client's allergies, patch tests, form and photos | **Clients** → the client |
| Get her figures for Self Assessment | **Money → Tax year → Download spreadsheet** |
| Back up | **Settings → Back up your data**, monthly |

---

## Privacy — what she's responsible for

She is the **data controller**. The app is built to make that easy, but these are hers to do:

- **Read the privacy notice** at `/privacy` and change anything that doesn't match how she works
  (file: `web/src/pages/public/Privacy.tsx`).
- **Health information** (consultation forms, patch tests, allergies) is only stored after the client
  ticks the explicit consent box. Don't add health notes for a client who hasn't given that consent.
- **If a client asks to be deleted:** Clients → the client → **Delete client and all their records**.
  Payment records stay, because HMRC requires them.
- **Data processing agreements:** Supabase and Google both offer standard terms for processing data on
  her behalf. Accept Supabase's DPA in the dashboard (Organization → Legal documents).
- **Keep the phone locked** with Face ID/passcode. Anyone holding the unlocked phone can open the diary.
- **If something goes wrong** (lost phone, someone else got in): change her password straight away.
  If client data may have been exposed, she may need to tell the ICO within 72 hours.

---

## What this app does not do

So nobody is surprised later:

- **No card payments.** Money is cash or bank transfer, recorded by hand. Deposits are checked
  against her bank app by the booking reference, then ticked off.
- **No automatic WhatsApp.** Automatic WhatsApp messages cost money per message, so the app opens
  WhatsApp with the message ready and she presses send.
- **No text messages (SMS)**. They cost about 4p each.
- **No marketplace.** Unlike Fresha, nobody finds her *through* the app. She shares her link.
- **No phone notifications for new bookings.** She gets an email instead, within 10 minutes.
- **Clients can't cancel or move bookings themselves.** They reply to the email or WhatsApp her, and she changes it.
- **No expenses tracking.** It records money received. Keep receipts for products, training and insurance separately.
- **One person only.** It's built for one diary, not a salon with staff.

---

## If something isn't working

| Problem | What to do |
|---|---|
| Clients say they got no email | App → Settings → Email shows when the script last checked in. In [script.google.com](https://script.google.com) → the project → **Executions** shows any errors. Ask them to check junk. |
| "Can't reach the server" | The free Supabase project may have been paused. Supabase dashboard → the project → **Restore**. |
| The email script says the secret was refused | App → Settings → Email → **Make a new secret**, paste it into Script Properties → `EMAIL_SECRET`. |
| Forgot the password | Sign-in screen → **Forgotten password?** |
| Changed the web address | Update **Settings → Business details → This app's web address**, and Supabase → Authentication → URL Configuration. |
| Wants it to look different, or a new feature | Everything is in this folder. See [README.md](README.md). |
