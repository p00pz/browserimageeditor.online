import { attachHandoff } from '../ui/tool-handoff.js';
/**
 * Saving — the one path every tool uses to get a finished image off the page.
 *
 * The chain, in priority order, and why each step is where it is:
 *
 *   1. **Web Share API.** On iOS/iPadOS — and anywhere `navigator.canShare({files})` is true —
 *      `navigator.share({files})` is the only route that reaches the Photos app. Safari requires
 *      the call to happen inside the visitor's own tap, so `saveBlob()` reaches `navigator.share()`
 *      before it awaits anything. That works because the tools build their output blob *before* the
 *      save control is clickable: nothing here encodes anything on the tap. The one exception is
 *      the Photos-friendly copy below, which is why it is pre-rendered while the result is being
 *      shown, never on the tap. A dismissed sheet (`AbortError`) is the visitor changing their
 *      mind, so it stays silent; anything else falls through to the next step.
 *   1b. **Photos-friendly copy.** iOS does not accept every image format in the share sheet in
 *      every version — WebP in particular can be refused by Photos on older builds. When the
 *      finished blob is not already JPEG or PNG, `primePhotosVariant()` bakes a JPEG copy (PNG when
 *      the image has transparency) while the page is showing the result, so the tap still hands
 *      Safari a ready File. The original is kept for the Files download and the on-screen readout
 *      always names the format that was really saved.
 *   2. **Fallback viewer.** An in-app browser (Facebook, Instagram, WhatsApp, TikTok, LinkedIn,
 *      Quora, X, WeChat, Line, Naver, KakaoTalk, Snapchat) cannot download reliably and often
 *      cannot do it at all, and an iOS Safari whose share did not succeed has no other route to
 *      the library. Rather than navigating the page to a blob: URL — which in those browsers means
 *      losing the tool — the finished image is shown full-screen as a plain real `<img>`: the
 *      browser's own press-and-hold menu does the saving, so nothing here may suppress that menu
 *      (no `-webkit-touch-callout`, no `user-select`, no overlay, no handlers on the image). A batch
 *      becomes one image per screen with a counter. "Open in Safari" is offered only inside a
 *      genuine webview — never in Safari itself.
 *   3. **Anchor download.** Everywhere else — desktops and Android — a blob: URL on an
 *      `<a download>` is still the reliable answer. `file-io.js` owns that mechanism, including
 *      the pagehide revocation, so a URL never outlives the tab.
 *
 * The DOM contract of the viewer is fixed and styled in `components.css`: a `div.save-viewer`
 * containing a `div.save-viewer-stage` with one `img.save-viewer-img` per image, and a
 * `div.save-viewer-foot` holding `button.save-viewer-close`, `p.save-viewer-hint`,
 * `span.save-viewer-counter` and `button.save-viewer-open`. It is built here, appended to the body,
 * and removed again on close. `?debug=1` pins a `pre.save-debug` diagnostics trace to the page.
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
  'fb_iab',
  'instagram',
  'whatsapp',
  'tiktok',
  'micromessenger',
  'linkedin',
  'quora',
  'twitter',
  'line/',
  'naver',
  'kakaotalk',
  'snapchat',
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
 * anything else takes its chances with the download even in a webview. An iPhone or iPad reaching
 * this point has already tried sharing and it did not work, so the viewer is genuinely its only
 * remaining route to the camera roll; the "Open in Safari" button is a separate, webview-only
 * decision made where the button is rendered.
 */
export function needsFallbackViewer(blob, userAgent = agent()) {
  if (!blob || !String(blob.type ?? '').startsWith('image/')) return false;
  if (isInAppBrowser(userAgent)) return true;
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

/* ---------- ?debug=1 diagnostics ---------- */

/** Pinned to the page only when the visitor asks for it, so it costs nothing otherwise. */
const debugEnabled =
  typeof location !== 'undefined' && typeof URLSearchParams === 'function'
    ? new URLSearchParams(location.search || '').has('debug')
    : false;

/** The last save attempt, in the order it happened. */
const trace = [];

function record(entry) {
  if (!debugEnabled) return;
  trace.push({ ...entry, at: new Date().toISOString() });
  renderDebug();
}

let debugEl = null;

function renderDebug() {
  if (!debugEnabled) return;
  if (!debugEl) {
    debugEl = document.createElement('pre');
    debugEl.className = 'save-debug';
    debugEl.setAttribute('aria-hidden', 'true');
    document.body.append(debugEl);
  }
  const userAgent = agent();
  debugEl.textContent = JSON.stringify(
    {
      ua: userAgent,
      ios: isIosAgent(userAgent),
      webview: isInAppBrowser(userAgent),
      canShare: typeof navigator !== 'undefined' && typeof navigator.canShare === 'function',
      trace,
    },
    null,
    1,
  );
}

/* ---------- the Photos-friendly copy ---------- */

/**
 * Pre-rendered JPEG/PNG copy of a finished blob, for the one platform that may refuse the original
 * format in its share sheet. Keyed by the source blob, so a result shown once is only ever baked
 * once; the WeakMap drops it with the blob. `null` means "no copy needed" and is cached too.
 */
const photosVariant = new WeakMap();

/** Above this pixel count the transparency probe reads a downscaled copy to keep memory bounded. */
const PROBE_MAX_PIXELS = 4_000_000;

/** The smallest alpha value in an ImageData buffer, so transparency is detected, not guessed. */
function minAlpha(data) {
  let smallest = 255;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < smallest) smallest = data[i];
    if (smallest === 0) break;
  }
  return smallest;
}

/** A canvas, or null where canvases do not exist (a Node test). */
function makeCanvas(width, height) {
  if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') return null;
  if (typeof OffscreenCanvas === 'function') {
    try {
      return new OffscreenCanvas(width, height);
    } catch {
      // A zero-size or refused canvas falls through to the 2D path.
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function encodeToCanvasBlob(bitmap, targetType) {
  const canvas = makeCanvas(bitmap.width, bitmap.height);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);
  const area = bitmap.width * bitmap.height;
  let opaque = true;
  if (area > 0) {
    if (area > PROBE_MAX_PIXELS) {
      // Probe a smaller copy: full-resolution alpha is not worth an iPhone's memory.
      const scale = Math.sqrt(PROBE_MAX_PIXELS / area);
      const probe = makeCanvas(
        Math.max(1, Math.round(bitmap.width * scale)),
        Math.max(1, Math.round(bitmap.height * scale)),
      );
      if (probe) {
        const pctx = probe.getContext('2d');
        if (pctx) {
          pctx.drawImage(bitmap, 0, 0, probe.width, probe.height);
          opaque = minAlpha(pctx.getImageData(0, 0, probe.width, probe.height).data) === 255;
        }
      }
    } else {
      opaque = minAlpha(ctx.getImageData(0, 0, canvas.width, canvas.height).data) === 255;
    }
  }
  const type = targetType === 'image/png' || !opaque ? 'image/png' : 'image/jpeg';
  if (typeof canvas.convertToBlob === 'function') {
    return { blob: await canvas.convertToBlob({ type, quality: 0.92 }), type };
  }
  return null;
}

/** Swaps the extension for the one the encoded copy actually carries. */
function retargetName(filename, type) {
  const ext = type === 'image/png' ? 'png' : 'jpg';
  const stem = String(filename || 'image').replace(/\.[^.]+$/, '');
  return `${stem}.${ext}`;
}

/**
 * Bakes the Photos-friendly copy of a result the page is already showing.
 *
 * Call this the moment a result is presented — never on the save tap, or Safari would lose the
 * user activation that the share sheet needs. Resolves to the File or to null when no copy is
 * needed (already JPEG/PNG, not an image, not iOS) or the platform cannot bake one; every one of
 * those outcomes is cached so it is settled before any tap.
 */
export async function primePhotosVariant({ blob, filename } = {}) {
  if (!blob || !(blob.size >= 0)) return null;
  if (photosVariant.has(blob)) return photosVariant.get(blob);
  const type = String(blob.type || '').toLowerCase();
  if (!type.startsWith('image/') || type === 'image/jpeg' || type === 'image/png') {
    photosVariant.set(blob, null);
    return null;
  }
  if (!isIosAgent()) {
    photosVariant.set(blob, null);
    return null;
  }
  let result = null;
  try {
    if (typeof createImageBitmap !== 'function') {
      photosVariant.set(blob, null);
      return null;
    }
    const bitmap = await createImageBitmap(blob);
    try {
      const encoded = await encodeToCanvasBlob(bitmap, 'image/jpeg');
      if (encoded?.blob && encoded.blob.size > 0) {
        result = new File([encoded.blob], retargetName(filename, encoded.type), {
          type: encoded.type,
        });
      }
    } finally {
      bitmap.close?.();
    }
  } catch {
    // A bitmap that cannot be decoded or a canvas that cannot encode leaves the original untouched;
    // the share then takes its chances with the real file, which is still the honest fallback.
    result = null;
  }
  photosVariant.set(blob, result);
  record({ step: 'prime-variant', from: blob.type, to: result?.type, size: result?.size });
  return result;
}

/** The plain-language note for the case where Photos got a copy rather than the original format. */
function photosCopyMessage(variant) {
  return t('js.save.photosCopy', {
    name: variant.name,
    size: formatBytes(variant.size),
    format: formatLabel(variant.type),
  });
}

/* ---------- the fallback viewer ---------- */

let viewer = null;
const viewerUrls = [];

function closeFallbackViewer() {
  if (!viewer) return;
  document.removeEventListener('keydown', viewerKeydown, true);
  viewer.remove();
  viewer = null;
  for (const url of viewerUrls) {
    // The image is gone, so its URL can go too; file-io still holds each as a pagehide backstop.
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Already gone is not a problem.
    }
  }
  viewerUrls.length = 0;
  document.body.style.overflow = '';
}

function viewerKeydown(event) {
  if (!viewer) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeFallbackViewer();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusables = [...viewer.querySelectorAll('button:not([disabled])')].filter(
    (button) => button.offsetParent !== null,
  );
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Opens the finished images full-screen, in the browsers that cannot save them any other way.
 *
 * The element is created here and removed on close, so nothing is left in the DOM between saves;
 * `hidden` is unset only once the first image has decoded, so the viewer never appears empty. The
 * image is deliberately a plain `<img>` with the browser's own callout intact — that menu is the
 * whole point of this view — and it carries no pointer or touch handlers of its own.
 */
function openFallbackViewer(entries) {
  closeFallbackViewer();

  const list = entries.filter((entry) => entry?.blob && entry.blob.size >= 0);
  if (list.length === 0) return;

  const root = document.createElement('div');
  root.className = 'save-viewer';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', t('js.save.shareTitle'));

  const stage = document.createElement('div');
  stage.className = 'save-viewer-stage';

  const foot = document.createElement('div');
  foot.className = 'save-viewer-foot';

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'save-viewer-close';
  closeButton.textContent = t('js.webview.close');
  foot.append(closeButton);

  const hint = document.createElement('p');
  hint.className = 'save-viewer-hint';
  hint.textContent = list.length > 1 ? t('js.webview.viewerHintMany') : t('js.webview.viewerHint');
  foot.append(hint);

  const counter = document.createElement('span');
  counter.className = 'save-viewer-counter';
  counter.hidden = list.length < 2;
  counter.textContent = t('js.webview.counter', { n: 1, total: list.length });
  counter.setAttribute('aria-live', 'polite');
  foot.append(counter);

  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.className = 'save-viewer-open';
  openButton.textContent = t('js.webview.openInSafari');
  // Offered only inside a genuine in-app browser. Safari itself is the browser this opens, so
  // showing it there is a dead button that duplicates the tab the visitor is already in.
  openButton.hidden = !isInAppBrowser();
  foot.append(openButton);

  root.append(stage, foot);
  document.body.append(root);
  // The sheet stays put while the visitor decides; the tool underneath must not scroll behind it.
  document.body.style.overflow = 'hidden';

  let revealed = false;
  list.forEach((entry, index) => {
    const url = URL.createObjectURL(entry.blob);
    // Tracked by file-io.js: a viewer left open cannot outlive its blob URLs once the tab is hidden.
    trackObjectUrl(url);
    viewerUrls.push(url);

    const image = document.createElement('img');
    image.className = 'save-viewer-img';
    image.alt = entry.filename || '';
    image.src = url;
    stage.append(image);

    if (index === 0) {
      // Revealed once the first image has actually decoded, so the viewer never appears empty.
      const reveal = () => {
        if (viewer !== root) return;
        root.hidden = false;
        closeButton.focus?.();
      };
      image.addEventListener('load', reveal, { once: true });
      image.addEventListener('error', reveal, { once: true });
      revealed = true;
    }
  });

  if (list.length > 1) {
    stage.addEventListener(
      'scroll',
      () => {
        if (!stage.children.length) return;
        const child = stage.children[0];
        const n = Math.round(stage.scrollLeft / child.clientWidth) + 1;
        counter.textContent = t('js.webview.counter', {
          n: Math.min(Math.max(1, n), list.length),
          total: list.length,
        });
      },
      { passive: true },
    );
  }

  closeButton.addEventListener('click', closeFallbackViewer);
  openButton.addEventListener('click', () => {
    // A webview that cannot save often cannot open a new tab either; the tap is still the shortest
    // path out of it, and the hint stands in for a manual copy of the address.
    window.open(location.href, '_blank');
  });

  document.addEventListener('keydown', viewerKeydown, true);
  if (!revealed) root.hidden = false;
  viewer = root;
  record({ step: 'viewer', images: list.length });
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
  const ios = isIosAgent(userAgent);
  // Pre-rendered while the result was being shown — never here — so the tap keeps its activation.
  const variant = ios ? photosVariant.get(blob) : null;
  const shareFile = variant && variant.size > 0 ? variant : file;
  const shareable = canShareFiles([shareFile]);
  // iOS 13.1–14 accepts a shared file without exposing canShare for it. On iOS the sheet is still
  // worth trying, and a rejection falls through to the viewer or the download below.
  const legacyIosShare = !shareable && ios && typeof navigator?.share === 'function';

  record({
    step: 'share',
    canShare: shareable,
    blobType: blob.type,
    blobSize: blob.size,
    filename: name,
    sharedName: shareFile.name,
    sharedType: shareFile.type,
    sharedSize: shareFile.size,
  });

  if (shareable || legacyIosShare) {
    try {
      // Fired before the first await in this function, inside the user gesture.
      await navigator.share(sharePayload([shareFile]));
      announce(
        statusEl,
        shareFile === variant
          ? photosCopyMessage(variant)
          : savedMessage(blob, name),
      );
      return SAVE_SHARED;
    } catch (error) {
      record({ step: 'share-error', name: error?.name, message: error?.message });
      // Dismissing the sheet is the visitor's decision, not a failure: stay silent and stop.
      if (error?.name === 'AbortError') return SAVE_CANCELLED;
      // NotAllowedError and anything else mean share is not really available; keep going.
    }
  }

  if (needsFallbackViewer(blob, userAgent)) {
    announce(statusEl, t('js.webview.hint'));
    openFallbackViewer([{ blob, filename: name }]);
    return SAVE_FALLBACK;
  }

  downloadBlob(blob, name);
  announce(statusEl, savedMessage(blob, name));
  return SAVE_DOWNLOADED;
}

/**
 * Saves a batch. When one share call can carry the whole array it is used as-is — one sheet, one
 * tap — and otherwise, on a platform where a download cannot be trusted, every image goes into the
 * single swipeable viewer so each one can be held and saved in turn. Everywhere else each file is
 * saved on its own, so a batch never fails as a unit because the browser drew the line at two
 * photos.
 */
export async function saveFiles({ files, filename, statusEl = null } = {}) {
  const list = (files ?? [])
    .filter((file) => file && file.size >= 0)
    .map((file) => (file instanceof File ? file : toFile(file, file.name || filename)));
  if (list.length === 0) {
    announce(statusEl, t('js.save.failed'), 'error');
    return SAVE_FALLBACK;
  }

  if (list.length === 1) {
    return saveBlob({ blob: list[0], filename: list[0].name || filename, statusEl });
  }

  const userAgent = agent();

  if (canShareFiles(list)) {
    try {
      record({ step: 'share-many', count: list.length, canShare: true });
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
      record({ step: 'share-many-error', name: error?.name, message: error?.message });
      if (error?.name === 'AbortError') return SAVE_CANCELLED;
    }
  }

  if (isIosAgent(userAgent) || isInAppBrowser(userAgent)) {
    // One viewer, one image per screen: every picture is hold-to-save, and the counter keeps the
    // place. Nothing is downloaded behind the visitor's back.
    announce(statusEl, t('js.webview.hint'));
    openFallbackViewer(list.map((file) => ({ blob: file, filename: file.name })));
    return SAVE_FALLBACK;
  }

  let last = SAVE_FALLBACK;
  for (const file of list) {
    last = await saveBlob({ blob: file, filename: file.name || filename, statusEl });
  }
  return last;
}

/**
 * Saves a batch the way this platform can actually take it, and reports whether it did.
 *
 * Returns `SAVE_SHARED` / `SAVE_FALLBACK` when the batch left the page through the share sheet or
 * the viewer — in which case the caller stops, because there is nothing left to package. Returns
 * `null` when the platform should build its ZIP instead (the Files-app route). On iOS Safari an
 * `<a download>` ZIP is not saveable at all, so the share sheet or the viewer is not an
 * alternative there — it is the only working path.
 */
export async function saveBatchOrZip({ entries, statusEl = null } = {}) {
  if (!isIosAgent()) return null;
  const list = (entries ?? [])
    .filter((entry) => entry?.blob && entry.blob.size >= 0)
    .map((entry) => toFile(entry.blob, entry.filename));
  if (list.length === 0) return null;
  const result = await saveFiles({ files: list, statusEl });
  if (result === SAVE_SHARED || result === SAVE_FALLBACK) return result;
  return null;
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
  const detachHandoff = attachHandoff(anchor, { getBlob, getFilename, statusEl });

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
  return () => { anchor.removeEventListener('click', handler); detachHandoff(); };
}
