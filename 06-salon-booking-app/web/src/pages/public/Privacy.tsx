import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { BrandHero, BrandIcon, Heart } from '../../components/brand';
import { Icon, useLoad } from '../../components/ui';
import { useClientManifest } from '../../components/clientManifest';

/** A page-only line icon (a page of notes), drawn like the brand icons. */
function NotesIcon() {
  return (
    <svg aria-hidden="true" focusable="false" width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 3.5h7.5L19 8v11a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1-1.5z" />
      <path d="M14.5 3.5V8H19M9.5 12.5h5M9.5 16h5" />
    </svg>
  );
}

const SECTIONS: { id: string; title: string; icon: ReactNode }[] = [
  { id: 'who', title: 'Who looks after your information', icon: <BrandIcon name="shield-heart" size={22} /> },
  { id: 'what', title: 'What is kept, why, and on what basis', icon: <NotesIcon /> },
  { id: 'others', title: 'Who else handles it', icon: <Icon name="clients" size={22} /> },
  { id: 'how-long', title: 'How long it is kept', icon: <BrandIcon name="clock" size={22} /> },
  { id: 'rights', title: 'Your rights', icon: <BrandIcon name="sparkle" size={22} /> },
];

function Section({ n, children }: { n: number; children: ReactNode }) {
  const s = SECTIONS[n];
  return (
    <section className="card privacy-section" id={`privacy-${s.id}`} aria-labelledby={`privacy-${s.id}-title`}>
      <div className="privacy-head">
        <span className="privacy-icon">{s.icon}</span>
        <span className="privacy-num" aria-hidden="true">{String(n + 1).padStart(2, '0')}</span>
        <h2 id={`privacy-${s.id}-title`}>{s.title}</h2>
      </div>
      {children}
    </section>
  );
}

/**
 * Privacy notice (UK GDPR Articles 13 and 14). It is written for a one-person
 * UK nail business using this app. The owner is the data controller and should
 * read it and change anything that doesn't match how she works. It renders even
 * if the database can't be reached, because people must always be able to read it.
 */
export function Privacy() {
  useClientManifest();
  const { data, loading } = useLoad(() => api.getBookingInfo(), []);
  const business = data?.business_name ?? 'This business';
  const owner = data?.legal_name?.trim();
  const email = data?.contact_email?.trim();
  const contact = email ? <a href={`mailto:${email}`}>{email}</a> : 'the email address on your booking confirmation';

  return (
    <div className="page page-public privacy">
      <BrandHero name="Privacy notice" compact>
        <p className="privacy-for">{loading ? ' ' : business}</p>
      </BrandHero>

      <nav className="card privacy-toc" aria-label="Contents">
        <p className="privacy-toc-title">On this page</p>
        <ol>
          {SECTIONS.map((s, i) => (
            <li key={s.id}>
              <a href={`#privacy-${s.id}`}>
                <span className="privacy-toc-num" aria-hidden="true">{i + 1}</span>
                <span>{s.title}</span>
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <Section n={0}>
        <p>
          {business} is run by {owner ? <b>{owner}</b> : 'its owner'}, a self-employed sole trader, who is responsible for your
          information (the “data controller”). To ask anything about it, contact {contact}.
        </p>
      </Section>

      <Section n={1}>
        <ul className="privacy-list">
          <li><b>Your name, email, mobile and bookings</b> — to make and manage your appointments and send confirmations and
            reminders. <i>Basis: to provide the service you asked for (contract).</i></li>
          <li><b>Changes you make to your booking</b> — your confirmation email has a private link to change or cancel your
            booking. Anyone with the link can use it, so please don’t share it. Changes you make there, and any reason you give
            for cancelling, are recorded so {business} can see them. <i>Basis: contract.</i></li>
          <li><b>Payments you make</b> — to keep the business records HMRC requires. <i>Basis: legal obligation.</i></li>
          <li><b>Treatment notes and photos of your nails</b> — to remember your preferences and keep accurate treatment
            records. Photos are private and never posted anywhere without asking you first.
            <i> Basis: legitimate interest in keeping accurate treatment records.</i></li>
          <li><b>Health and allergy information</b> (the consultation form, patch-test results and allergy notes) — only so your
            treatments are safe for you. <i>Basis: your explicit consent (UK GDPR Article 9(2)(a)), which you give on the form
            and can withdraw at any time.</i> It may be kept longer only if needed to deal with a legal claim.</li>
        </ul>
      </Section>

      <Section n={2}>
        <p>A few providers handle your information only to provide their service to {business}:</p>
        <ul className="privacy-list">
          <li><b>Supabase</b> — the database and photo storage. Records are stored in London; Supabase (a US company) may access
            them for support and security under UK-approved safeguards.</li>
          <li><b>Netlify</b> — hosts this booking website. It doesn’t store your booking, but its servers log technical data such as
            IP addresses.</li>
          <li><b>Google</b> — booking emails (your name, email, appointment and any deposit details) are sent from, and kept in,{' '}
            {business}’s Gmail account, and may be stored outside the UK.</li>
          <li><b>WhatsApp</b> — if we message each other there.</li>
          <li>The <b>bank</b> sees the name on a deposit transfer; an <b>accountant and HMRC</b> may see payment records.</li>
        </ul>
        <p className="privacy-promise">
          <Heart size={18} filled className="privacy-promise-heart" />
          <span>Your information is never sold, or used for marketing without asking you first.</span>
        </p>
      </Section>

      <Section n={3}>
        <ul className="privacy-list privacy-keep">
          <li><b>Client details, notes, photos and consultation forms:</b> deleted 3 years after your last appointment, or sooner if
            you ask.</li>
          <li><b>Booking requests that never went ahead:</b> deleted after 6 months.</li>
          <li><b>Payment records:</b> at least 5 years after the 31 January Self Assessment deadline for that tax year (for example,
            payments in 2025–26 are kept until at least 31 January 2032). If you ask to be deleted, your name stays on these
            records only.</li>
        </ul>
      </Section>

      <Section n={4}>
        <p>
          You can ask to see the information held about you, to have it corrected or deleted, to restrict or object to how it is
          used, or to receive a copy to take elsewhere. You can withdraw consent for your health information at any time — it
          will then be deleted, though treatments that need it may not be possible.
        </p>
        <p className="privacy-contact">
          To use any of these rights, or to complain, email {contact}. A complaint will be acknowledged within 30 days and
          answered as soon as possible. If you are still unhappy, you can contact the Information Commissioner’s Office at{' '}
          <a href="https://ico.org.uk/make-a-complaint/" target="_blank" rel="noreferrer">ico.org.uk</a> or 0303 123 1113.
        </p>
      </Section>

      <p className="privacy-back"><Link className="btn" to="/book">Back to booking</Link></p>
    </div>
  );
}
