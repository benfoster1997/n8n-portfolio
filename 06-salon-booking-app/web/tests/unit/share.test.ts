import { describe, expect, it } from 'vitest';
import { shareOrCopy, type ShareOrCopyNavigator } from '../../src/lib/share';

// Sharing a link from a tap, on stand-in phones: the share sheet where there is one, then the
// clipboard, then a box to copy it from.

const LINK = { title: 'Demo Nail Studio', text: 'Book your nails with Demo Nail Studio', url: 'https://book.example.com/book?from=friend' };
const abort = () => Object.assign(new Error('Share canceled'), { name: 'AbortError' });

/** A phone that can share (or not), copy (or not), and records what it was given. */
function phone({ share, copy }: { share?: (d: ShareData) => Promise<void>; copy?: (t: string) => Promise<void> }) {
  const shared: ShareData[] = [];
  const copied: string[] = [];
  const prompted: [string, string][] = [];
  const nav: ShareOrCopyNavigator = {
    ...(share ? { share: async (d: ShareData) => { shared.push(d); await share(d); } } : {}),
    ...(copy ? { clipboard: { writeText: async (t: string) => { copied.push(t); await copy(t); } } } : {}),
  };
  const prompt = (message: string, value: string) => { prompted.push([message, value]); };
  return { nav, prompt, shared, copied, prompted };
}

describe('shareOrCopy', () => {
  it('opens the share sheet where the phone has one', async () => {
    const p = phone({ share: async () => {}, copy: async () => {} });
    expect(await shareOrCopy(LINK, p.nav, p.prompt)).toBe('shared');
    expect(p.shared).toEqual([{ title: LINK.title, text: LINK.text, url: LINK.url }]);
    expect(p.copied).toEqual([]);
  });

  it('closing the share sheet is "cancelled", and nothing else happens', async () => {
    const p = phone({ share: async () => { throw abort(); }, copy: async () => {} });
    expect(await shareOrCopy(LINK, p.nav, p.prompt)).toBe('cancelled');
    expect([p.copied, p.prompted]).toEqual([[], []]);
  });

  it('a share sheet that fails another way copies the link instead', async () => {
    const p = phone({ share: async () => { throw Object.assign(new Error('Not allowed'), { name: 'NotAllowedError' }); }, copy: async () => {} });
    expect(await shareOrCopy(LINK, p.nav, p.prompt)).toBe('copied');
    expect(p.copied).toEqual([`${LINK.text} ${LINK.url}`]);
  });

  it('with no share sheet it copies: the words with the link, once', async () => {
    const p = phone({ copy: async () => {} });
    expect(await shareOrCopy(LINK, p.nav, p.prompt)).toBe('copied');
    expect(await shareOrCopy({ title: 'x', text: `Spaces tomorrow. Book here: ${LINK.url}`, url: LINK.url }, p.nav, p.prompt)).toBe('copied');
    expect(await shareOrCopy({ title: 'x', url: LINK.url }, p.nav, p.prompt)).toBe('copied');
    expect(p.copied).toEqual([`${LINK.text} ${LINK.url}`, `Spaces tomorrow. Book here: ${LINK.url}`, LINK.url]);
  });

  it('with no share sheet and no clipboard (or copying not allowed), it shows the link to copy', async () => {
    const none = phone({});
    expect(await shareOrCopy({ title: 'x', url: LINK.url }, none.nav, none.prompt)).toBe('prompt');
    expect(none.prompted).toEqual([['Copy this link:', LINK.url]]);
    const refused = phone({ copy: async () => { throw new Error('Write permission denied.'); } });
    expect(await shareOrCopy(LINK, refused.nav, refused.prompt)).toBe('prompt');
    expect(refused.prompted).toEqual([['Copy this:', `${LINK.text} ${LINK.url}`]]);
    expect(await shareOrCopy(LINK, undefined, none.prompt)).toBe('prompt');
  });

  it('shares just a title and link when there are no words', async () => {
    const p = phone({ share: async () => {} });
    expect(await shareOrCopy({ title: LINK.title, url: LINK.url }, p.nav, p.prompt)).toBe('shared');
    expect(p.shared).toEqual([{ title: LINK.title, url: LINK.url }]);
  });
});
