import { useEffect } from 'react';

const CLIENT_MANIFEST = '/book.webmanifest';

/**
 * Client pages (booking, manage, form, privacy) swap in the booking page's own
 * home-screen manifest, so "Add to Home Screen" opens /book, never the owner's
 * sign-in. Restored on the way out.
 */
export function useClientManifest() {
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    const title = document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]');
    const before = { href: link?.getAttribute('href'), title: title?.getAttribute('content') };
    link?.setAttribute('href', CLIENT_MANIFEST);
    title?.setAttribute('content', 'Book');
    return () => {
      if (before.href) link?.setAttribute('href', before.href);
      if (before.title) title?.setAttribute('content', before.title);
    };
  }, []);
}
