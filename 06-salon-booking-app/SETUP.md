# Setting up the booking app

This guide gets the app live for one nail business, for **£0 a month**. It takes about
**45 minutes** at a computer, plus five minutes on the iPhone. There's no coding: it's all
clicking, copying and pasting.

You'll create three free accounts. Use the business's own email for all of them, so
everything belongs to the business owner rather than to whoever sets it up. Turn on
**two-step login** for each one: client health records are behind these accounts.

| Service | What it does | Cost |
|---|---|---|
| **Supabase** | The private database: bookings, clients, forms, photos, takings | Free plan |
| **Netlify** | Puts the app on the web at an address like `yourstudio.netlify.app` | Free plan |
| **Google Apps Script** (in her Gmail) | Sends confirmation and reminder emails from her own Gmail | Free |

> **Does she have to use Netlify?** No, she never sees it. A home-screen web app is a web page
> that the phone keeps on the home screen, so it has to live at a web address. That address is
> also where clients book, change and cancel. Netlify is just the free host for that address.
> Whoever sets the app up does step 2 once. After that, she only ever taps the icon on her home
> screen. (Cloudflare Pages or Vercel would do the same job. The only way to have no web host
> at all would be an App Store app, which costs about £79 a year for Apple's developer account and still
> needs a web page for client bookings.)

> **Before you start:** a business that keeps client records, especially health information
> like allergies, has to pay the **ICO data protection fee**. That's £52 a year for a small
> business, or £47 by direct debit. It's a legal requirement whatever app is used, so she may
> already pay it. Check at [ico.org.uk/fee](https://ico.org.uk/for-organisations/data-protection-fee/).
> Sole traders' details appear on the ICO's public register, so if possible give a business
> address rather than her home.

---

## 1. Create the database (Supabase): 15 minutes

1. Go to [supabase.com](https://supabase.com) → **Start your project** → sign up with the business email.
2. Create a **New project**:
   - Name: `bookings`
   - Database password: press **Generate a password** and save it in a password manager. You'll rarely need it.
   - **Region: West EU (London)**. This matters because it keeps client data in the UK, and it can't be changed later.
   - Plan: **Free**.
3. Wait a minute or two while it sets up.
4. Left menu → **SQL Editor** → **New query**. Open [`supabase/schema.sql`](supabase/schema.sql),
   copy **all** of it, paste it in and press **Run**. It should say *Success. No rows returned*.
5. **New query** again. Paste all of [`supabase/storage.sql`](supabase/storage.sql) and press **Run**.
6. **New query** once more. Run this line with **her** email address in it. Only an account
   with this email can ever become the owner of the diary:
   ```sql
   update public.settings set owner_email = 'her.email@example.com' where id = 1;
   ```
7. Left menu → **Project Settings** → **API** (sometimes called **Data API** or **API Keys**). Copy these two into a note:
   - the **Project URL**, e.g. `https://abcdefghijkl.supabase.co`
   - the **anon / public** key, a long string. A **publishable** key (`sb_publishable_…`) works too.

   ⚠️ Never use the **service_role** or **secret** key anywhere in this app. It bypasses every privacy rule.
8. **Organization → Legal Documents**: sign Supabase's **Data Processing Agreement**. It's free and
   signed online.

---

## 2. Put the app online (Netlify): 10 minutes

1. Go to [netlify.com](https://www.netlify.com) and sign up. The free plan allows business use.
2. **Add new site → Import an existing project → GitHub**, and pick this repository.
3. Settings:
   - **Base directory:** `06-salon-booking-app/web`
   - **Build command:** `npm run build` (filled in automatically from `netlify.toml`)
   - **Publish directory:** `dist`
4. **Environment variables → Add**:
   - `VITE_SUPABASE_URL` = the Project URL from step 1.7
   - `VITE_SUPABASE_ANON_KEY` = the anon key from step 1.7
5. **Deploy**. After a minute you get an address like `random-name-123.netlify.app`.
6. **Site configuration → Change site name** to something tidy, e.g. `yourstudio` → `https://yourstudio.netlify.app`.
7. Back in **Supabase → Authentication → URL Configuration**:
   - **Site URL:** your Netlify address, e.g. `https://yourstudio.netlify.app`
   - **Redirect URLs → Add:** `https://yourstudio.netlify.app/**`

   This makes the "reset password" link open the app.

> If the two environment variables are missing, the site shows *Not set up yet* rather than
> quietly running without a database. To look around first, add `VITE_DEMO=1` instead to get
> the **demo**, with invented data kept only in your browser. Then remove it when you add the real values.

---

## 3. Create her owner account: 5 minutes

Lock the door first, then make her key:

1. **Supabase → Authentication → Sign In / Providers**: turn **off** **"Allow new users to sign up"**,
   leave **Anonymous sign-ins** off, then **Save**. Now nobody can create an account from the website.
2. **Supabase → Authentication → Users → Add user → Create new user**: use her email (the same one
   as in step 1.6) and a strong password of 10+ characters, and tick **Auto confirm user**.
3. On her iPhone, open **Safari**, go to the Netlify address and **sign in** with that email and
   password. The first time she signs in, the diary becomes hers. Any other account sees nothing.

---

## 4. Add it to the home screen: 1 minute

In Safari on the iPhone, open the app's address (the one she signed in on, **not** `/book`), tap
**Share** (the square with the arrow), then **Add to Home Screen**, name it **Bookings** and tap
**Add**. It now opens full-screen like an app, with its own icon, and she stays signed in.

Her side of the app (diary, clients, money, settings) only opens for her account. Clients only ever
see the booking pages. If a client adds the booking page to *their* home screen, their icon opens
the booking page, never her sign-in.

---

## 5. Fill in her details in the app: 10 minutes

Open the app and go to **Settings**:

1. **Business details**:
   - The business name and **her legal name**. The privacy notice has to say who is responsible for client data.
   - A line of welcome text, and the area, which is shown publicly. The full address only goes in confirmation emails.
   - Her email, where new-booking alerts go and which the privacy notice uses as the contact address.
   - Her mobile (optional).
   - **This app's web address**: tap *Use …netlify.app*.
2. **Booking page** (optional): the words that dress up her booking page. Anything left blank is left off.
   - A **tagline** in pink handwriting under the business name, and a **strapline**: a few words in
     spaced capitals, separated by commas.
   - The **add-ons menu**, e.g. nail art and extras priced per nail. One per line: `Name | price` is an
     item, a line starting with `>` is a note, and any other line is a heading. A preview under the box
     shows how it will read. It's for information only: clients add these on the day, not online.
   - A **safety note** for the PPE and hygiene badge.
   - Her **Instagram, TikTok and Facebook** names. She can type the handle or paste the link to her profile.
   - **Preview booking page** shows the result once it's saved.
3. **Opening hours**: the days and times clients can book, and any lunch break.
4. **Treatments & prices**: add each service, with how long it really takes (including removal).
5. **Deposits & cancellations**:
   - The deposit for new clients (e.g. £10) and how many hours they have to pay it.
   - Whether unpaid bookings are released automatically. This is off by default: late ones are just flagged.
   - The account name, sort code and account number. These are only ever sent to clients who owe a deposit.
   - Her cancellation policy. It's already filled in: *at least 48 hours' notice to cancel or move,
     otherwise the full price of the treatment is payable*. It shows at the top of the booking page and
     in every confirmation and reminder email. Clients have to tick to agree before booking, and each
     booking keeps a copy of the wording they agreed to.
   - **Notice needed to cancel**: 48 hours, to match the policy.
   - **Clients can change or cancel online**: on by default. Every confirmation and reminder has a
     private link where the client can move their appointment, switch treatment or cancel, at any time
     before it starts. If they do it with less than 48 hours' notice, it still goes through, but it's
     flagged as **late**, and she gets an email alert. **The app doesn't collect the charge:** she
     arranges that with the client herself, and can record the money in the app when it arrives.
     Once a client has changed a booking inside the 48 hours, cancelling it later still counts as
     late, and the amount payable stays at the price before the change. So moving late, or switching
     to something cheaper, can't be used to dodge or shrink the charge.
6. **Booking rules**: the gap between clients (clean-up time), the minimum notice, how far ahead people
   can book, and when reminders go out. Reminders are set to **72 hours (3 days) before**, for both the
   email and the WhatsApp list. That gives clients a full day to change their plans before the 48-hour
   cut-off.
7. **WhatsApp messages** (optional): the wording of the reminder, deposit and confirmation messages.
   The reminder already includes the client's change/cancel link and the date to change by.

Until the essentials are done, the **Today** screen shows a "Finish setting up" list.

---

## 6. Switch on emails (Google Apps Script): 10 minutes

This sends confirmation, deposit, reminder, change and cancellation emails **from her own Gmail**,
for free. It also emails her when a client books, changes or cancels.
It uses Google's MailApp, which can *send* email but **can't read her inbox**.

1. In the app, go to **Settings → Email confirmations & reminders → Create the secret**.
   Copy the secret now, because it's only shown once. Leave this page open: it also shows the URL and key to copy.
2. On a computer signed in to **her** Google account, go to [script.google.com](https://script.google.com) → **New project**.
   Name it `Booking emails`.
3. Delete what's in `Code.gs` and paste in **all** of [`apps-script/Code.gs`](apps-script/Code.gs). Press **Save** 💾.
4. Go to **Project Settings** (the cog on the left) → **Script Properties → Add script property**, three times:

   | Property | Value |
   |---|---|
   | `SUPABASE_URL` | the Project URL |
   | `SUPABASE_ANON_KEY` | the anon key |
   | `EMAIL_SECRET` | the secret from step 1 |

   *(Optional: the repository also has `appsscript.json`, which limits the script to exactly the
   four permissions it needs. To use it, tick **Show "appsscript.json"** in Project Settings and paste
   the file over it. Without it, Google works out the same permissions anyway.)*
5. Go back to the **Editor** (`< >`). In the function dropdown at the top, choose **`setup`** and press **Run**.
   Google asks for permission:
   - **Review permissions** → choose her account.
   - You'll see "Google hasn't verified this app", because it's her own script. Tap **Advanced → Go to Booking emails** → **Allow**.
6. The log should end with *All set…*.
7. Choose **`sendTestEmail`** → **Run** to see a sample deposit email in her inbox.
8. **Triggers** (the clock icon on the left) → the `processEmails` trigger → set **failure notifications**
   to **Notify me immediately**. If the script ever stops, she'll get an email.
9. In the app, **Settings → Email** should now say *Email sender last checked in … — working.*

From now on it runs every 10 minutes by itself, even with the computer off. It never takes on more
emails than Gmail will still send that day (about 100 for a personal account). Test a real booking
once and check the new-booking alert **notifies her phone**.

> The email script checks in every 10 minutes, which also keeps the free Supabase project
> awake. Free projects pause after a week with no activity.

---

## 7. Share the booking link

Her booking page is `https://yourstudio.netlify.app/book`, and the **Today** screen has a **Share link** button.
- **Instagram:** Edit profile → Links → add it, along with the privacy notice (`…/privacy`) if there's room.
- **WhatsApp Business:** Settings → Business tools → Profile → Website.
- **Google Business Profile:** Edit profile → Booking link.

---

## 8. Moving across from Fresha

1. In Fresha, **export her client list** (Clients → Export) and note all future appointments.
2. Add each upcoming appointment in the new app: **Diary → +**. Search for or add the client, pick the time, and untick the deposit.
3. On each regular's record, tick **Regular client — never asked for a new-client deposit**. Otherwise the app
   treats them as new until their first visit is marked done.
4. Health information doesn't come across from Fresha automatically. For each regular, either send the form link
   from their next appointment, or record written consent you already hold before adding allergies or patch tests.
5. Swap the booking link on Instagram and WhatsApp to the new one.
6. Keep Fresha running until every Fresha booking has happened, then cancel the subscription
   and ask Fresha to delete the data it holds for her business.

Clients found through Fresha's marketplace won't find her there any more. New clients now come
from her own Instagram, WhatsApp, Google profile and word of mouth.

---

## Day to day

| She wants to… | Where |
|---|---|
| See today and anything waiting on her | **Today** |
| Send WhatsApp reminders (appointments in the next 3 days) | **Today → Send N WhatsApp reminders**: tap each one, WhatsApp opens with the message written, press send |
| See what clients have changed or cancelled themselves | **Today → Changed by clients** (she's also emailed each time). Late ones are marked **Late**. |
| Follow up a late cancellation | The appointment → **Late cancellation** → WhatsApp the client, then **Record payment received** when the money arrives |
| Move a booking herself | The appointment → **Change time**. Leave *Email … their new time* ticked and the client is told. |
| A client cancels late by WhatsApp or phone | The appointment → **Cancel** → tick *… cancelled with less than 48 hours' notice*. It's then flagged like an online late cancellation. |
| A booking says "the mobile given is different" | A returning client typed a new number when booking. Check which is right and tap **Use this number** or **Keep the record's number** before you WhatsApp them. |
| A change/cancel link reached the wrong person | The appointment → **Make a new link**. The old one stops working straight away. |
| Confirm a new client's deposit has arrived | Today → *Deposits waiting* → the booking → **Deposit received** (the client is emailed automatically) |
| Finish an appointment and record payment | The appointment → **Finish & take payment** → cash or bank transfer |
| Block a holiday or a dentist appointment | **Diary → Block time** |
| See a client's allergies, patch tests, form and photos | **Clients** → the client |
| Get her figures for Self Assessment | **Money → Tax year → Download spreadsheet** |
| Back up | **Settings → Back up your data**, monthly. Keep only the last three, somewhere encrypted. |

---

## Privacy: what she's responsible for

She is the **data controller**. The app is built to make that easier, but these jobs are hers:

- **Read the privacy notice** at `/privacy` and change anything that doesn't match how she works
  (file: `web/src/pages/public/Privacy.tsx`). For example, it says client records are deleted 3 years after the
  last visit. Check that with her insurer.
- **Health information only with consent.** New clients give explicit consent on the online form. For anyone else,
  send the form link, or record consent she already holds in writing on their record ("Record consent"),
  *before* adding allergies or patch tests. The app won't let her add them until consent is recorded.
- **If a client withdraws consent:** Clients → the client → **Delete health information only**.
- **If a client asks to be deleted**, she must do it within one month:
  1. In the app: Clients → the client → **Delete client and all their records**. Payment records keep their name, because HMRC requires them.
  2. In Gmail: search for their email address and delete the booking emails.
  3. Delete the WhatsApp chat, and their photos from the camera roll and iCloud.
- **Every few months:** on **Clients**, tick *Show only the clients due for deletion* and delete them, as the privacy
  notice promises.
- **Processing agreements:** Supabase's is signed in step 1.8, and Netlify's is in its Terms. **Free Gmail has no data
  processing agreement.** That's a common compromise for sole traders, but strictly speaking a paid Google Workspace
  plan (about £6 a month) is the fully compliant option.
- **Paperwork:** because she keeps health information, she needs a one-page *record of processing* (the ICO has a free
  template) and a simple log of anything that goes wrong.
- **If something goes wrong**, such as a lost phone or someone else getting in: change her password straight away.
  If client data may have been exposed, she may need to tell the ICO within **72 hours**.
- **Keep the phone locked** with Face ID or a passcode. Anyone holding the unlocked phone can open the diary.
- **Change/cancel links are private to each client.** They're only sent to the client's own email (or
  by her on WhatsApp), and they only open that one booking. Anyone a client forwards the link to could
  change or cancel that booking, so the privacy notice tells clients not to share it. If a link
  reaches the wrong person, **Make a new link** on the appointment switches the old one off.

---

## What this app does not do

So nobody is surprised later:

- **No card payments.** Money is cash or bank transfer, recorded by hand. She checks deposits
  against her bank app using the booking reference, then ticks them off.
- **No automatic WhatsApp.** Automated WhatsApp messages are charged per message, so the app opens
  WhatsApp with the message ready and she presses send.
- **No text messages (SMS)**, because they cost about 4p each.
- **No marketplace.** Unlike Fresha, nobody finds her *through* the app. She shares her link.
- **No phone notifications for new bookings.** She gets an email instead, within 10 minutes.
- **No charging for late cancellations.** Clients can change or cancel online at any time, but the app
  doesn't take the late-cancellation charge. It flags the booking, tells her, and she arranges payment
  herself (then records it in the app). A booking can be changed online up to 6 times; after that the
  client has to get in touch. Across all bookings, online changes are capped at 10 an hour and 40 a day,
  so the links can't be used to use up her Gmail allowance.
- **No expenses tracking.** It only records money received, so she should keep receipts for products, training and insurance separately.
- **One person only.** It's built for one diary, not a salon with staff.
- **A brake on online bookings.** At most 6 an hour, 25 a day and 15 waiting for a deposit, and 3 an hour from any
  one internet connection. This stops someone flooding the diary or using her Gmail to send spam. Real clients
  who hit it are asked to try later or get in touch.

---

## If something isn't working

| Problem | What to do |
|---|---|
| A client says the change/cancel link doesn't work | Links stop working a day after the appointment, and changes aren't possible once it has started. Check **Settings → Deposits & cancellations → Clients can change or cancel online** is on. |
| Clients say they got no email | App → Settings → Email shows when the script last checked in. At [script.google.com](https://script.google.com) → the project → **Executions**, you can see any errors. Ask the client to check their junk folder. |
| "Can't reach the server" | The free Supabase project may have paused. Go to the Supabase dashboard → the project → **Restore**. |
| The email script says the secret was refused | App → Settings → Email → **Make a new secret**, then paste it into Script Properties → `EMAIL_SECRET`. |
| "This diary already has an owner" | Someone signed in with a different email. Sign out and use the email from step 1.6. |
| Forgot the password | On the sign-in screen, tap **Forgotten password?** |
| **Settings → Booking page** won't save ("Could not find the … column") | The app is newer than the database. Run [`supabase/schema.sql`](supabase/schema.sql) again in the SQL Editor (it keeps all her data and settings), then save again. |
| Changed the web address | Update **Settings → Business details → This app's web address**, and Supabase → Authentication → URL Configuration. |
| Wants it to look different, or a new feature | Everything is in this folder. See [README.md](README.md). |
