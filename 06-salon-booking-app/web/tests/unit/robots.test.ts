import { describe, expect, it } from 'vitest';
import robots from '../../public/robots.txt?raw';

type Rule = { allow: boolean; path: string };

/** The Allow and Disallow lines of the group(s) for one crawler; comments and other fields are skipped. */
function rulesFor(txt: string, agent: string): Rule[] {
  const rules: Rule[] = [];
  let agents: string[] = [];
  let inRules = false;
  for (const raw of txt.split(/\r?\n/)) {
    const m = /^\s*([a-z-]+)\s*:\s*(.*?)\s*$/i.exec(raw.replace(/#.*/, ''));
    if (!m) continue;
    const field = m[1].toLowerCase();
    if (field === 'user-agent') {
      if (inRules) { agents = []; inRules = false; } // a new group starts
      agents.push(m[2].toLowerCase());
    } else if (field === 'allow' || field === 'disallow') {
      inRules = true;
      if (agents.includes(agent) && m[2]) rules.push({ allow: field === 'allow', path: m[2] });
    }
  }
  return rules;
}

/** "/assets/*.js$" → a pattern from the start of the path: * is anything, a final $ the end. */
function pattern(rule: string): RegExp {
  const end = rule.endsWith('$');
  const body = (end ? rule.slice(0, -1) : rule).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${end ? '$' : ''}`);
}

/** Google's reading: the longest matching rule wins, Allow wins a tie, and no match is allowed. */
function allowed(txt: string, path: string, agent = '*'): boolean {
  let best: Rule | null = null;
  for (const r of rulesFor(txt, agent)) {
    if (!pattern(r.path).test(path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

describe('the checker reads robots.txt as Google does', () => {
  it('follows the longest matching rule, Allow winning a tie, and only the group for its crawler', () => {
    expect(allowed('User-agent: *\nDisallow: /\nAllow: /a', '/a/b')).toBe(true);
    expect(allowed('User-agent: *\nAllow: /\nDisallow: /a', '/a/b')).toBe(false);
    expect(allowed('User-agent: *\nDisallow: /a\nAllow: /a', '/a')).toBe(true);
    expect(allowed('User-agent: *\nDisallow: /*.png$', '/x.png')).toBe(false);
    expect(allowed('User-agent: *\nDisallow: /*.png$', '/x.png?v=2')).toBe(true);
    expect(allowed('User-agent: other\nDisallow: /', '/x')).toBe(true);
    expect(allowed('# nothing here', '/x')).toBe(true);
  });
});

describe('robots.txt', () => {
  it('lets search engines read the booking page, and load what it needs to draw it', () => {
    for (const path of [
      '/book', '/book?from=card', '/book?treatment=biab-infill', '/book.webmanifest',
      '/assets/x.js', '/assets/index-AbC123.css', '/assets/nunito-latin-wght-normal-AbC123.woff2',
      '/icons/icon-192.png', '/icons/apple-touch-icon.png', '/og/booking-card.jpg',
    ]) {
      expect(allowed(robots, path), path).toBe(true);
    }
  });

  it('keeps out the owner’s app and the private links', () => {
    for (const path of ['/', '/clients', '/clients/123', '/diary', '/money', '/settings', '/appointments/123', '/manage/x', '/form/x']) {
      expect(allowed(robots, path), path).toBe(false);
    }
  });
});
