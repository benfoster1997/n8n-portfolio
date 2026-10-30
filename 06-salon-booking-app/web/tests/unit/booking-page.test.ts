import { describe, expect, it } from 'vitest';
import { checkHandle, cleanHandle, parseMenu, socialLink, SOCIAL_SITES } from '../../src/lib/text';

describe('parseMenu (the add-ons menu in Settings → Booking page)', () => {
  it('reads headings, "Name | price" items and "> " notes into sections', () => {
    const text = [
      'Nail art',
      'Simple nail art | 50p per nail',
      'Gems & charms | £1 per nail',
      '> Lots of colours counts as detailed. Just ask!',
      'Extras',
      'Chrome powder | £5',
    ].join('\n');
    expect(parseMenu(text)).toEqual([
      {
        title: 'Nail art',
        items: [{ name: 'Simple nail art', price: '50p per nail' }, { name: 'Gems & charms', price: '£1 per nail' }],
        notes: ['Lots of colours counts as detailed. Just ask!'],
      },
      { title: 'Extras', items: [{ name: 'Chrome powder', price: '£5' }], notes: [] },
    ]);
  });

  it('puts anything before the first heading in a section with no title', () => {
    expect(parseMenu('French tips | £5\n> Any colour\nGlitter\nGlitter fade | £4')).toEqual([
      { title: null, items: [{ name: 'French tips', price: '£5' }], notes: ['Any colour'] },
      { title: 'Glitter', items: [{ name: 'Glitter fade', price: '£4' }], notes: [] },
    ]);
  });

  it('ignores blank lines and spaces, and copes with Windows and old Mac line endings', () => {
    expect(parseMenu('\r\n   Extras  \r\n\r\n  Chrome powder   |   £5  \rFrench tips|£5\n\n')).toEqual([
      { title: 'Extras', items: [{ name: 'Chrome powder', price: '£5' }, { name: 'French tips', price: '£5' }], notes: [] },
    ]);
  });

  it('splits an item at the first "|" only', () => {
    expect(parseMenu('Ombré | 2 colours | £6')[0].items).toEqual([{ name: 'Ombré', price: '2 colours | £6' }]);
  });

  it('keeps an item with no price, but skips one with no name and an empty note', () => {
    expect(parseMenu('Extras\nHand massage |\n| £3\n>   \n>Ask about seasonal designs')).toEqual([
      { title: 'Extras', items: [{ name: 'Hand massage', price: '' }], notes: ['Ask about seasonal designs'] },
    ]);
  });

  it('keeps a heading with nothing under it, in order', () => {
    expect(parseMenu('Coming soon\nExtras\nChrome powder | £5').map((s) => s.title)).toEqual(['Coming soon', 'Extras']);
  });

  it('gives an empty list for nothing at all', () => {
    expect(parseMenu(null)).toEqual([]);
    expect(parseMenu(undefined)).toEqual([]);
    expect(parseMenu('')).toEqual([]);
    expect(parseMenu(' \n \n')).toEqual([]);
  });
});

describe('social handles', () => {
  it('strips a leading @ and spaces', () => {
    expect(cleanHandle('  @yournailstudio ')).toBe('yournailstudio');
    expect(cleanHandle('yournailstudio')).toBe('yournailstudio');
    expect(cleanHandle('')).toBeNull();
    expect(cleanHandle('   ')).toBeNull();
    expect(cleanHandle(null)).toBeNull();
    expect(cleanHandle('@')).toBeNull();
  });

  it('turns a pasted profile link into the handle', () => {
    expect(cleanHandle('https://www.instagram.com/your.nail_studio/?hl=en')).toBe('your.nail_studio');
    expect(cleanHandle('instagram.com/yournailstudio')).toBe('yournailstudio');
    expect(cleanHandle('http://instagr.am/yournailstudio')).toBe('yournailstudio');
    expect(cleanHandle('https://m.facebook.com/YourNailStudio/')).toBe('YourNailStudio');
    expect(cleanHandle('https://www.facebook.com/YourNailStudio/about#top')).toBe('YourNailStudio');
    expect(cleanHandle('fb.com/YourNailStudio')).toBe('YourNailStudio');
  });

  it('leaves a link with no handle in it as typed, so the check catches it', () => {
    expect(cleanHandle('https://www.facebook.com/profile.php?id=1000123')).toBe('https://www.facebook.com/profile.php?id=1000123');
    expect(cleanHandle('https://www.instagram.com/p/AbC123/')).toBe('https://www.instagram.com/p/AbC123/');
    expect(cleanHandle('https://www.instagram.com/')).toBe('https://www.instagram.com/');
  });

  it('accepts handles the database accepts', () => {
    expect(checkHandle('instagram', '@your.nail_studio')).toEqual({ handle: 'your.nail_studio', error: null });
    expect(checkHandle('instagram', 'a')).toEqual({ handle: 'a', error: null });
    expect(checkHandle('instagram', 'a'.repeat(30)).handle).toBe('a'.repeat(30));
    expect(checkHandle('facebook', 'https://www.facebook.com/Your.Nail.Studio')).toEqual({ handle: 'Your.Nail.Studio', error: null });
  });

  it('blank is fine: no link is shown', () => {
    expect(checkHandle('instagram', '')).toEqual({ handle: null, error: null });
    expect(checkHandle('facebook', '   ')).toEqual({ handle: null, error: null });
    expect(checkHandle('instagram', null)).toEqual({ handle: null, error: null });
  });

  it('refuses what the database refuses, with a friendly message', () => {
    const bad: [Parameters<typeof checkHandle>[0], string][] = [
      ['instagram', 'a'.repeat(31)],
      ['instagram', 'your nail studio'],
      ['instagram', 'your-nails'],
      ['instagram', '<script>'],
      ['facebook', 'Nail'],
      ['facebook', 'Your_Nail_Studio'],
      ['facebook', 'https://www.facebook.com/profile.php?id=1000123'],
      ['instagram', 'https://www.instagram.com/'],
      ['instagram', 'https://example.com/yournailstudio'],
      ['instagram', 'javascript:alert(1)'],
    ];
    for (const [site, input] of bad) {
      const r = checkHandle(site, input);
      expect(r.handle, `${site} ${input}`).toBeNull();
      expect(r.error).toBe(SOCIAL_SITES[site].problem);
    }
  });

  it('notices a link to the wrong site', () => {
    expect(checkHandle('facebook', 'https://www.instagram.com/yournailstudio/')).toEqual({
      handle: null, error: 'That’s a link to Instagram. Paste your Facebook link here, or just your handle.' });
    expect(checkHandle('instagram', 'facebook.com/YourNailStudio').error).toMatch(/link to Facebook/);
  });

  it('a handle that only starts like a site name is just a handle', () => {
    expect(checkHandle('instagram', 'instagram.comedy')).toEqual({ handle: 'instagram.comedy', error: null });
  });

  it('builds each site’s profile link', () => {
    expect(socialLink('instagram', 'your.nails')).toBe('https://www.instagram.com/your.nails/');
    expect(socialLink('facebook', 'YourNailStudio')).toBe('https://www.facebook.com/YourNailStudio');
  });
});
