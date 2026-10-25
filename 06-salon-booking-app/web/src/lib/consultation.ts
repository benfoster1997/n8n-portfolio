// The new-client consultation form. Edit the questions here; answers are stored
// as-is (question id → answer) so old forms still display after a change.
//
// These are the kind of questions UK nail technicians commonly ask before a
// first gel, acrylic or BIAB treatment. They are not medical advice; the
// owner should review them against her own insurance and training provider.

export type Question =
  | { id: string; type: 'yesno'; label: string; detailsLabel?: string }
  | { id: string; type: 'checks'; label: string; options: string[] }
  | { id: string; type: 'text'; label: string; placeholder?: string };

export const CONSULTATION_QUESTIONS: Question[] = [
  {
    id: 'allergies',
    type: 'yesno',
    label: 'Do you have any allergies? (for example to acrylates/HEMA, latex, adhesives, fragrance or plasters)',
    detailsLabel: 'Please give details',
  },
  {
    id: 'previous_reaction',
    type: 'yesno',
    label: 'Have you ever had a reaction to gel, acrylic, nail glue or any nail product?',
    detailsLabel: 'What happened, and when?',
  },
  {
    id: 'conditions',
    type: 'checks',
    label: 'Do any of these apply to you right now? Tick all that apply.',
    options: [
      'Diabetes',
      'Poor circulation',
      'Eczema, psoriasis or dermatitis on hands or feet',
      'Nail fungal infection',
      'Cuts, swelling or broken skin around the nails',
      'Recently damaged or lifting nails',
      'Pregnant',
      'Undergoing chemotherapy',
    ],
  },
  {
    id: 'medication',
    type: 'yesno',
    label: 'Are you taking any medication that affects your skin or nails? (for example blood thinners, isotretinoin, steroids)',
    detailsLabel: 'Which medication?',
  },
  {
    id: 'other',
    type: 'text',
    label: 'Anything else I should know before your appointment?',
    placeholder: 'Optional',
  },
];

export type Answers = Record<string, unknown>;

export function blankAnswers(): Answers {
  const a: Answers = {};
  for (const q of CONSULTATION_QUESTIONS) {
    if (q.type === 'yesno') { a[q.id] = null; a[`${q.id}_details`] = ''; }
    else if (q.type === 'checks') a[q.id] = [];
    else a[q.id] = '';
  }
  return a;
}

/** Returns the first problem with the answers, or null if they are complete. */
export function validateAnswers(a: Answers): string | null {
  for (const q of CONSULTATION_QUESTIONS) {
    if (q.type === 'yesno') {
      if (a[q.id] !== 'yes' && a[q.id] !== 'no') return `Please answer: “${q.label}”`;
      if (a[q.id] === 'yes' && !String(a[`${q.id}_details`] ?? '').trim()) return `Please add details for: “${q.label}”`;
    }
  }
  return null;
}

/** Turn stored answers into readable lines for the owner. */
export function describeAnswers(a: Answers): { question: string; answer: string; flag: boolean }[] {
  const rows: { question: string; answer: string; flag: boolean }[] = [];
  for (const q of CONSULTATION_QUESTIONS) {
    if (q.type === 'yesno') {
      const v = a[q.id];
      const details = String(a[`${q.id}_details`] ?? '').trim();
      rows.push({ question: q.label, answer: v === 'yes' ? `Yes — ${details}` : v === 'no' ? 'No' : '—', flag: v === 'yes' });
    } else if (q.type === 'checks') {
      const v = Array.isArray(a[q.id]) ? (a[q.id] as string[]) : [];
      rows.push({ question: q.label, answer: v.length ? v.join(', ') : 'None', flag: v.length > 0 });
    } else {
      const v = String(a[q.id] ?? '').trim();
      rows.push({ question: q.label, answer: v || '—', flag: false });
    }
  }
  return rows;
}

export const HEALTH_CONSENT_TEXT =
  'I confirm this information is correct, and I agree to it being stored securely so my treatment can be carried out safely. ' +
  'I will let you know if anything changes. I can ask for it to be deleted at any time.';
