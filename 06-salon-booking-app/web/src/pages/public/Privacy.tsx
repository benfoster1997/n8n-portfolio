import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Spinner, useLoad } from '../../components/ui';

/**
 * A plain-English privacy notice. It is a starting point written for a
 * one-person UK nail business using this app; the owner is the data controller
 * and should read it, and change it if anything here doesn't match how she
 * works (src/pages/public/Privacy.tsx).
 */
export function Privacy() {
  const { data } = useLoad(() => api.getBookingInfo(), []);
  if (!data) return <Spinner />;
  const name = data.business_name;
  return (
    <div className="page page-public prose">
      <h1>Privacy notice</h1>
      <p className="sub">{name}</p>

      <h2>Who looks after your information</h2>
      <p>{name} is a self-employed business and is responsible (the “data controller”) for the information you give when you book. Contact {name} directly with any question about it.</p>

      <h2>What is kept, and why</h2>
      <ul>
        <li><b>Your name, email and mobile number</b> — to manage your booking and send confirmations and reminders.</li>
        <li><b>Your appointments and what you paid</b> — to run the diary and keep the tax records the law requires.</li>
        <li><b>Your answers to the consultation form and any patch tests</b> — health information, used only so treatments are safe for you. This is kept only with your explicit consent, which you give when you tick the box on the form.</li>
        <li><b>Notes and photos of your nails</b> — to remember your preferences and keep a record of treatments. Photos are private and never posted anywhere without asking you first.</li>
      </ul>

      <h2>Who else handles it</h2>
      <p>Bookings are stored securely with Supabase (a database service, hosted in London). The booking website itself is hosted by Netlify and stores no client records. Emails are sent from {name}’s Gmail account (Google). Nobody else sees your information, and it is never sold or used for marketing without your permission.</p>

      <h2>How long it is kept</h2>
      <p>Client records are kept while you are a client and deleted if you ask, or after you haven’t visited for a long time. Payment records are kept for at least five years after the tax year they belong to, because HMRC requires it.</p>

      <h2>Your rights</h2>
      <p>You can ask to see the information held about you, to correct it, or to have it deleted (apart from records that must be kept for tax). You can withdraw consent for health information at any time — though treatments that need it may then not be possible. If you are unhappy with how your information is handled you can complain to the Information Commissioner’s Office (ico.org.uk).</p>

      <p style={{ marginTop: 24 }}><Link to="/book">Back to booking</Link></p>
    </div>
  );
}
