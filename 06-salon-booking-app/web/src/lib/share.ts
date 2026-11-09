// Sharing a link from a tap: the phone's share sheet where there is one (WhatsApp,
// Messages, Instagram…), otherwise the link is copied, and as a last resort it's shown
// ready to copy. Used for "Share with a friend" and the owner's links.
import { isAbort } from './files';

/** The parts of `navigator` used here, so the tests can stand in for a phone (as ShareNavigator in lib/files). */
export interface ShareOrCopyNavigator {
  share?: (data: ShareData) => Promise<void>;
  clipboard?: { writeText(text: string): Promise<void> };
}

export type ShareOutcome = 'shared' | 'cancelled' | 'copied' | 'prompt';

const theNavigator = (): ShareOrCopyNavigator | undefined => (typeof navigator === 'undefined' ? undefined : navigator);
const showToCopy = (message: string, value: string) => {
  if (typeof window !== 'undefined') window.prompt(message, value);
};

/**
 * Share a link, or copy it. 'shared': the share sheet took it. 'cancelled': she closed the share
 * sheet (say nothing). 'copied': it's on the clipboard (say so). 'prompt': shown in a box to copy
 * by hand. A share sheet that fails for any other reason falls back to copying, then to the box.
 */
export async function shareOrCopy(data: { title: string; text?: string; url: string },
  nav: ShareOrCopyNavigator | undefined = theNavigator(), prompt: (message: string, value: string) => void = showToCopy,
): Promise<ShareOutcome> {
  if (nav && typeof nav.share === 'function') {
    try {
      await nav.share(data.text ? { title: data.title, text: data.text, url: data.url } : { title: data.title, url: data.url });
      return 'shared';
    } catch (e) {
      if (isAbort(e)) return 'cancelled';
      // Not allowed here, or nothing to share to: copy it instead.
    }
  }
  // What's copied is what would have been shared: the words with the link, once.
  const text = data.text ? (data.text.includes(data.url) ? data.text : `${data.text} ${data.url}`) : data.url;
  if (nav?.clipboard && typeof nav.clipboard.writeText === 'function') {
    try {
      await nav.clipboard.writeText(text);
      return 'copied';
    } catch { /* not allowed: show it instead */ }
  }
  prompt(data.text ? 'Copy this:' : 'Copy this link:', text);
  return 'prompt';
}
