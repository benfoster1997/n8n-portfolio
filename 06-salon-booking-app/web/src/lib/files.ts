// Saving a file on her iPhone. A plain download link has been unreliable in home-screen apps
// on iPhones (the file can end up nowhere, or on a preview screen), so where the phone can,
// the file goes to the share sheet instead and she chooses Save to Files. iOS only opens the
// share sheet straight from a tap, so the file has to be ready before she taps.

/** The parts of `navigator` used here, so the tests can stand in for a phone. */
export interface ShareNavigator {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data?: ShareData) => boolean;
}

const theNavigator = (): ShareNavigator | undefined => (typeof navigator === 'undefined' ? undefined : navigator);

/**
 * The first file the phone's share sheet will take, or null when this browser can't share any
 * of them (then it's downloaded instead). Some browsers only share a few kinds of file, so a
 * backup is offered as JSON and then as plain text.
 */
export function firstShareable(files: File[], nav: ShareNavigator | undefined = theNavigator()): File | null {
  if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return null;
  for (const file of files) {
    try {
      if (nav.canShare({ files: [file] })) return file;
    } catch { /* not this kind: try the next */ }
  }
  return null;
}

/** Download a file through a link: what happens when the phone has no share sheet for it. */
export function downloadFile(file: Blob, name: string) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // iOS asks where to save before reading the file, so keep the link alive a while.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Save a file, from a tap: the share sheet where the phone can share one of `files` (she
 * chooses Save to Files), otherwise a download of the first. Resolves 'shared' once she has
 * picked where it goes, or 'downloaded'. Neither proves it was saved, so the screen asks her
 * to check it's in Files. Rejects with an AbortError when she closes the share sheet, and with
 * the browser's own error when the share sheet couldn't open.
 */
export async function saveFile(files: File[], nav: ShareNavigator | undefined = theNavigator()): Promise<'shared' | 'downloaded'> {
  const file = firstShareable(files, nav);
  if (file) {
    // Only the file: text or a title alongside it can arrive in Files as a second item.
    await nav!.share!({ files: [file] });
    return 'shared';
  }
  downloadFile(files[0], files[0].name);
  return 'downloaded';
}

/** She closed the share sheet without choosing anything. */
export const isAbort = (e: unknown) => (e as { name?: unknown } | null)?.name === 'AbortError';

/** "180 KB", "1.2 MB": a file's size, to show it's really there. */
export function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
