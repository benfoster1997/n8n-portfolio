import { Link } from 'react-router-dom';
import { api } from '../../api';
import { useLoad } from '../../components/ui';

/**
 * Privacy notice (UK GDPR Articles 13 and 14). It is written for a one-person
 * UK nail business using this app. The owner is the data controller and should
 * read it and change anything that doesn't match how she works. It renders even
 * if the database can't be reached, because people must always be able to read it.
 */
export function Privacy() {
  const { data } = useLoad(() => api.getBookingInfo(), []);
  const business = data?.business_name ?? 'This business';
  const owner = data?.legal_name?.trim();
  const email = data?.contact_email?.trim();
  const contact = email ? <a href={`mailto:${email}`}>{email}</a> : 'the email address on your booking confirmation';

  return (
    <div className="page page-public prose">
      <h1>Privacy notice</h1>
      <p className="sub">{business}</p>

      <h2>Who looks after your information</h2>
      <p>
        {business} is run by {owner ? <b>{owner}</b> : 'its owner'}, a self-employed sole trader, who is responsible for your
        information (the “data controller”). To ask anything about it, contact {contact}.
      </p>

      <h2>What is kept, why, and on what basis</h2>
      <ul>
        <li><b>Your name, email, mobile and bookings</b> — to make and manage your appointments and send confirmations and
          reminders. <i>Basis: to provide the service you asked for (contract).</i></li>
        <li><b>Payments you make</b> — to keep the business records HMRC requires. <i>Basis: legal obligation.</i></li>
        <li><b>Treatment notes and photos of your nails</b> — to remember your preferences and keep accurate treatment
          records. Photos are private and never posted anywhere without asking you first.
          <i> Basis: legitimate interest in keeping accurate treatment records.</i></li>
        <li><b>Health and allergy information</b> (the consultation form, patch-test results and allergy notes) — only so your
          treatments are safe for you. <i>Basis: your explicit consent (UK GDPR Article 9(2)(a)), which you give on the form
          and can withdraw at any time.</i> It may be kept longer only if needed to deal with a legal claim.</li>
      </ul>

      <h2>Who else handles it</h2>
      <p>A few providers handle your information only to provide their service to {business}:</p>
      <ul>
        <li><b>Supabase</b> — the database and photo storage. Records are stored in London; Supabase (a US company) may access
          them for support and security under UK-approved safeguards.</li>
        <li><b>Netlify</b> — hosts this booking website. It doesn’t store your booking, but its servers log technical data such as
          IP addresses.</li>
        <li><b>Google</b> — booking emails (your name, email, appointment and any deposit details) are sent from, and kept in,
          {business}’s Gmail account, and may be stored outside the UK.</li>
        <li><b>WhatsApp</b> — if we message each other there.</li>
        <li>The <b>bank</b> sees the name on a deposit transfer; an <b>accountant and HMRC</b> may see payment records.</li>
      </ul>
      <p>Your information is never sold, or used for marketing without asking you first.</p>

      <h2>How long it is kept</h2>
      <ul>
        <li>Client details, notes, photos and consultation forms: deleted 3 years after your last appointment, or sooner if
          you ask.</li>
        <li>Booking requests that never went ahead: deleted after 6 months.</li>
        <li>Payment records: at least 5 years after the 31 January Self Assessment deadline for that tax year (for example,
          payments in 2025–26 are kept until at least 31 January 2032). If you ask to be deleted, your name stays on these
          records only.</li>
      </ul>

      <h2>Your rights</h2>
      <p>
        You can ask to see the information held about you, to have it corrected or deleted, to restrict or object to how it is
        used, or to receive a copy to take elsewhere. You can withdraw consent for your health information at any time — it
        will then be deleted, though treatments that need it may not be possible.
      </p>
      <p>
        To use any of these rights, or to complain, email {contact}. A complaint will be acknowledged within 30 days and
        answered as soon as possible. If you are still unhappy, you can contact the Information Commissioner’s Office at{' '}
        <a href="https://ico.org.uk/make-a-complaint/" target="_blank" rel="noreferrer">ico.org.uk</a> or 0303 123 1113.
      </p>

      <p style={{ marginTop: 24 }}><Link to="/book">Back to booking</Link></p>
    </div>
  );
}
