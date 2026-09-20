/**
 * Saving — the one path every tool uses to get a finished image off the page.
 *
 * The chain, in priority order, and why each step is where it is:
 *
 *   1. **Web Share API.** On iOS/iPadOS — and anywhere `navigator.canShare({files})` is true —
 *      `navigator.share({files})` is the only route that reaches the Photos app. Safari requires
 *      the call to happen inside the visitor's own tap, so `saveBlob()` is written to reach
 *      `navigator.share()` before it awaits anything. That works because the tools build their
 *      output blob *before* the save control is clickable: nothing here encodes anything, the
 *      blob is cached and handed over as-is. A dismissed sheet (`AbortError`) is the visitor
 *      changing their mind, so it stays silent; anything else falls through to the next step.
 *   2. **Fallback viewer.** An in-app browser (Facebook, Instagram, WhatsApp, TikTok, LinkedIn,
 *      Quora, X, WeChat) cannot download reliably and often cannot do it at all, and an iOS
 *      Safari with no share capability has no other route to the library. Rather than navigating
 *      the page to a blob: URL — which in those browsers means losing the tool — the finished
 *      image is shown full-screen with "press and hold, then Save to Photos" and an affordance
 *      to open the same page in Safari. The tool underneath stays usable; only saving is affected.
 *   3. **Anchor download.** Everywhere else — desktops and Android — a blob: URL on an
 *      `<a download>` is still the reliable answer. `file-io.js` owns that mechanism, including
 *      the pagehide revocation, so a URL never outlives the tab.
 *
 * The DOM contract of the viewer is fixed and styled elsewhere: a `div.save-viewer` containing
 * `div.save-viewer-bar > button.save-viewer-close`, an `img.save-viewer-img`, a
 * `p.save-viewer-hint` and a `button.save-viewer-open`. It is built here, appended to the body,
 * and removed again on close.
 */
import { downloadBlob, trackObjectUrl } from './file-io.js';
import { formatLabel } from './formats.js';
import { formatBytes } from '../ui/format.js';
import { t } from '../ui/strings.js';

/** Result codes. The tools use them to decide whether to say anything at all. */
export const SAVE_SHARED = 'shared';
export const SAVE_DOWNLOADED = 'downloaded';
export const SAVE_CANCELLED = 'cancelled';
export const SAVE_FALLBACK = 'fallback';

/**
 * User-agent tokens that mark an in-app browser. Saving from one of those is unreliable enough
 * that the press-and-hold viewer is the better offer than a download that silently goes nowhere.
 */
const WEBVIEW_TOKENS = [
  'fban',
  'fbav',
  'instagram',
  'whatsapp',
  'tiktok',
  'micromessenger',
  'linkedin',
  'quora',
  'twitter',
];

/** The user agent of this document, or '' where there is no navigator (a Node test). */
function agent() {
  if (typeof navigator === 'undefined') return '';
  return navigator.userAgent ?? '';
}

/** True inside an in-app browser, where a download is likely to be swallowed rather than saved. */
export function isInAppBrowser(userAgent = agent()) {
  const ua = String(userAgent ?? '').toLowerCase();
  return WEBVIEW_TOKENS.some((token) => ua.includes(token));
}

/**
 * True on iPhone, iPad and iPod touch.
 *
 * iPadOS 13+ reports a desktop Mac UA with no iPad token in it, so it cannot be told apart from
 * macOS Safari by the user agent alone. Rather than guessing — and wrongly offering the
 * press-and-hold viewer on a desktop, or wrongly downloading on a tablet — the ambiguous case is
 * left out. A desktop Safari that cannot share still downloads reliably, which is the better
 * failure mode of the two.
 */
export function isIosAgent(userAgent = agent()) {
  return /(?:iphone|ipad|ipod)/.test(String(userAgent ?? '').toLowerCase());
}

/** True when the Web Share API can carry exactly these files. */
export function canShareFiles(files) {
  if (typeof navigator === 'undefined' || typeof navigator.canShare !== 'function') return false;
  if (!Array.isArray(files) || files.length === 0) return false;
  try {
    return Boolean(navigator.canShare({ files }));
  } catch {
    // canShare() throws on a payload it cannot describe rather than returning false.
    return false;
  }
}

/** A Blob becomes a File, because the share API takes files and a download filename wants a name. */
function toFile(blob, filename) {
  if (blob instanceof File) return blob;
  return new File([blob], String(filename || 'image'), { type: blob?.type || 'image/png' });
}

/** The title and text that travel with a shared file, from this page's own catalogue. */
function sharePayload(files) {
  return { files, title: t('js.save.shareTitle'), text: t('js.save.shareText') };
}

/**
 * True when the press-and-hold viewer is the right offer: saving is unlikely to work any other way.
 *
 * Only an image can be shown in it — the viewer's `img` would render an empty frame for a PDF — so
 * anything else takes its chances with the download even in a webview.
 */
export function needsFallbackViewer(blob, userAgent = agent()) {
  if (!blob || !String(blob.type ?? '').startsWith('image/')) return false;
  if (isInAppBrowser(userAgent)) return true;
  // Share was already tried and did not work by the time this is called, so an iOS device here has
  // no working share capability at all.
  return isIosAgent(userAgent);
}

/** Writes a message onto the page's existing `role="status"` line, if the caller passed one. */
function announce(statusEl, message, tone = 'info') {
  if (!statusEl || typeof message !== 'string' || message === '') return;
  statusEl.textContent = message;
  statusEl.classList.toggle('is-error', tone === 'error');
}

/** "Saved photo.webp (96 KB, WebP)." — the real output size and the real output format. */
function savedMessage(blob, filename) {
  return t('js.save.saved', {
    name: filename,
    size: formatBytes(blob.size),
    format: formatLabel(blob.type),
  });
}

/* ---------- the fallback viewer ---------- */

let viewer = null;
let viewerUrl = null;

function closeFallbackViewer() {
  if (!viewer) return;
  viewer.remove();
  viewer = null;
  // The image is gone, so its URL can go too; file-io still holds it as a pagehide backstop.
  if (viewerUrl) {
    try {
      URL.revokeObjectURL(viewerUrl);
    } catch {
      // Already gone is not a problem.
    }
    viewerUrl = null;
  }
}

/**
 * Opens the finished image full-screen, in the browsers that cannot save it any other way.
 *
 * The element is created here and removed on close, so nothing is left in the DOM between saves;
 * the classes are the contract another agent styles, and `hidden` is unset only once the image is
 * in place so the viewer never appears empty.
 */
function openFallbackViewer({ blob, filename }) {
  closeFallbackViewer();

  const root = document.createElement('div');
  root.className = 'save-viewer';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', t('js.save.shareTitle'));

  const bar = document.createElement('div');
  bar.className = 'save-viewer-bar';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'save-viewer-close';
  closeButton.textContent = t('js.webview.close');
  bar.append(closeButton);

  const image = document.createElement('img');
  image.className = 'save-viewer-img';
  image.alt = '';

  const hint = document.createElement('p');
  hint.className = 'save-viewer-hint';
  hint.textContent = t('js.webview.viewerHint');

  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.className = 'save-viewer-open';
  openButton.textContent = t('js.webview.openInSafari');

  root.append(bar, image, hint, openButton);
  document.body.append(root);

  const url = URL.createObjectURL(blob);
  // Tracked by file-io.js: a viewer left open cannot outlive its blob URL once the tab is hidden.
  trackObjectUrl(url);
  viewerUrl = url;

  // Revealed once the image has actually decoded, so the viewer never appears with an empty frame.
  // A blob URL always settles, so one of the two always fires.
  const reveal = () => {
    if (viewer !== root) return;
    root.hidden = false;
    closeButton.focus?.();
  };
  image.addEventListener('load', reveal, { once: true });
  image.addEventListener('error', reveal, { once: true });
  image.src = url;

  closeButton.addEventListener('click', closeFallbackViewer);
  openButton.addEventListener('click', () => {
    // A webview that cannot save often cannot open a new tab either; the tap is still the shortest
    // path out of it, and the hint above stands in for a manual copy of the address.
    window.open(location.href, '_blank');
  });

  viewer = root;
}

/* ---------- the save chain ---------- */

/**
 * Saves one pre-rendered blob.
 *
 * `share()` is reached without awaiting anything, so Safari still sees it as the visitor's tap.
 * Returns 'shared' (a share sheet completed), 'downloaded' (an anchor download started),
 * 'cancelled' (the visitor dismissed the sheet — reported nowhere, by design) or 'fallback'
 * (the viewer opened, because nothing else can save here).
 *
 * @param {object} args `{ blob, filename, statusEl }` — `statusEl` is the page's `role="status"`
 * line, which receives the real output size and format once the save is on its way.
 */
export async function saveBlob({ blob, filename, statusEl = null } = {}) {
  if (!blob || !(blob.size >= 0)) {
    announce(statusEl, t('js.save.failed'), 'error');
    return SAVE_FALLBACK;
  }

  const name = String(filename || 'image');
  const file = toFile(blob, name);
  const userAgent = agent();
  const shareable = canShareFiles([file]);
  // iOS 13.1–14 accepts a shared file without exposing canShare for it. On iOS the sheet is still
  // worth trying, and a rejection falls through to the viewer or the download below.
  const legacyIosShare = !shareable && isIosAgent(userAgent) && typeof navigator?.share === 'function';

  if (shareable || legacyIosShare) {
    try {
      // Fired before the first await in this function, inside the user gesture.
      await navigator.share(sharePayload([file]));
      announce(statusEl, savedMessage(blob, name));
      return SAVE_SHARED;
    } catch (error) {
      // Dismissing the sheet is the visitor's decision, not a failure: stay silent and stop.
      if (error?.name === 'AbortError') return SAVE_CANCELLED;
      // NotAllowedError and anything else mean share is not really available; keep going.
    }
  }

  if (needsFallbackViewer(blob, userAgent)) {
    announce(statusEl, t('js.webview.hint'));
    openFallbackViewer({ blob, filename: name });
    return SAVE_FALLBACK;
  }

  downloadBlob(blob, name);
  announce(statusEl, savedMessage(blob, name));
  return SAVE_DOWNLOADED;
}

/**
 * Saves a batch. When one share call can carry the whole array it is used as-is — one sheet, one
 * tap — and otherwise each file is saved on its own, so a batch never fails as a unit because the
 * browser drew the line at two photos.
 */
export async function saveFiles({ files, filename, statusEl = null } = {}) {
  const list = (files ?? []).filter((file) => file && file.size >= 0);
  if (list.length === 0) {
    announce(statusEl, t('js.save.failed'), 'error');
    return SAVE_FALLBACK;
  }

  if (list.length === 1) {
    return saveBlob({ blob: list[0], filename, statusEl });
  }

  if (canShareFiles(list)) {
    try {
      await navigator.share(sharePayload(list));
      announce(
        statusEl,
        t('js.save.savedMany', {
          count: list.length,
          images: t('js.common.imageMany'),
          size: formatBytes(list.reduce((sum, file) => sum + file.size, 0)),
        }),
      );
      return SAVE_SHARED;
    } catch (error) {
      if (error?.name === 'AbortError') return SAVE_CANCELLED;
    }
  }

  let last = SAVE_FALLBACK;
  for (const file of list) {
    last = await saveBlob({ blob: file, filename: file.name || filename, statusEl });
  }
  return last;
}

/**
 * Wires an existing `<a data-download download>` element to the save chain.
 *
 * The tools set the anchor's `href` and `download` as they always did, which stays the path a
 * browser with no JavaScript takes. With JavaScript running, the anchor's own navigation is
 * cancelled here and `saveBlob()` owns every route instead — so the same tap shares on iOS,
 * opens the viewer inside an in-app browser, and downloads everywhere else.
 *
 * `getBlob` and `getFilename` are called on the tap rather than at wire time, because the anchor
 * is wired once and then reused for every result the page produces.
 *
 * Returns a cleanup function that removes the listener.
 */
export function wireDownloadAnchor(anchor, { getBlob, getFilename, statusEl } = {}) {
  if (!anchor) return () => {};

  const handler = (event) => {
    const blob = typeof getBlob === 'function' ? getBlob() : null;
    if (!blob) {
      event.preventDefault();
      announce(statusEl, t('js.save.failed'), 'error');
      return;
    }
    event.preventDefault();
    const filename = typeof getFilename === 'function' ? getFilename() : undefined;
    void saveBlob({ blob, filename, statusEl });
  };

  anchor.addEventListener('click', handler);
  return () => anchor.removeEventListener('click', handler);
}
