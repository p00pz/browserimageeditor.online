/**
 * Save-path helpers. Run with `npm test` (or `node --test tests/save-photo.test.js`).
 *
 * `navigator.share` cannot be exercised outside a browser, so what is covered here is every pure
 * decision the save chain makes before it reaches a browser API: which user agent counts as an
 * in-app browser, which one counts as iOS, whether the fallback viewer is the right offer, and the
 * adaptive pixel budget that keeps a huge iPhone photo from reaching a canvas that cannot hold it.
 * The message formatting is checked too, because "the real size and the real format" is the one
 * promise the status line makes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canShareFiles,
  isInAppBrowser,
  isIosAgent,
  needsFallbackViewer,
  primePhotosVariant,
  saveBatchOrZip,
} from '../src/assets/js/core/save-photo.js';
import {
  CompressError,
  DEFAULT_MAX_PIXELS,
  WEBKIT_SAFE_MAX_PIXELS,
  assertPixelBudget,
  compressFile,
  fitToPixelBudget,
  isWebKitAgent,
  safeMaxPixels,
} from '../src/assets/js/core/engine-compress.js';
import { createStrings } from '../src/assets/js/ui/strings.js';

const t = createStrings({
  'js.save.saved': 'Saved {name} ({size}, {format}).',
  'js.webview.counter': '{n} / {total}',
  'js.common.downscaled': 'The image was reduced to {w} × {h} to fit this device’s memory.',
});

/* ---------- user-agent detection ---------- */

test('in-app browsers are detected by their own tokens', () => {
  assert.equal(isInAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'), false);
  assert.equal(isInAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.53.94;FBBV/...]'), true);
  assert.equal(isInAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 320.0.0.27.114'), true);
  assert.equal(isInAppBrowser('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 WhatsApp/2.23.20.0'), true);
  assert.equal(isInAppBrowser('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'), false);
  assert.equal(isInAppBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'), false);
  assert.equal(isInAppBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'), false);
  // A TikTok in-app browser, and the token the Android WeChat webview uses.
  assert.equal(isInAppBrowser('Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 musical_ly_32.0.0 TikTok/32.0.0'), true);
  assert.equal(isInAppBrowser('Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 MMWEBID/1234 MicroMessenger/8.0.40'), true);
  // Nothing at all is not an in-app browser, and neither is an empty string.
  assert.equal(isInAppBrowser(''), false);
  assert.equal(isInAppBrowser(null), false);
  assert.equal(isInAppBrowser(undefined), false);
});

test('iOS is detected from its device tokens, and a desktop Mac is not called iOS', () => {
  assert.equal(isIosAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'), true);
  assert.equal(isIosAgent('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'), true);
  assert.equal(isIosAgent('Mozilla/5.0 (iPod touch; CPU iPhone OS 17_0 like Mac OS X)'), true);
  // Chrome on iOS is still iOS, and still WebKit.
  assert.equal(isIosAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1'), true);
  // A desktop Safari is deliberately not treated as iOS: it downloads reliably.
  assert.equal(isIosAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'), false);
  assert.equal(isIosAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'), false);
  assert.equal(isIosAgent(''), false);
});

test('the fallback viewer is offered for an image where saving is otherwise impossible', () => {
  const photo = new Blob([new Uint8Array(8)], { type: 'image/webp' });
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
  const instagram = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 320.0.0.27.114';
  const desktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  assert.equal(needsFallbackViewer(photo, instagram), true, 'an in-app browser cannot save');
  assert.equal(needsFallbackViewer(photo, iphone), true, 'iOS without a working share has no other route');
  assert.equal(needsFallbackViewer(photo, desktop), false, 'a desktop downloads');
  // A document is not an image, so it takes its chances with a download instead of an empty frame.
  assert.equal(needsFallbackViewer(new Blob([new Uint8Array(8)], { type: 'application/pdf' }), instagram), false);
  assert.equal(needsFallbackViewer(null, instagram), false);
});

test('canShareFiles is false without a navigator that can answer', () => {
  assert.equal(canShareFiles([]), false, 'an empty list asks for nothing');
  assert.equal(canShareFiles(null), false);
  assert.equal(canShareFiles([new File([new Uint8Array(4)], 'a.png', { type: 'image/png' })]), false);
});

/* ---------- the messages ---------- */

test('the saved message carries the real size and the real format', () => {
  const photo = new Blob([new Uint8Array(1024 * 96)], { type: 'image/webp' });
  assert.equal(
    t('js.save.saved', { name: 'photo.webp', size: '96 KB', format: 'WebP' }),
    'Saved photo.webp (96 KB, WebP).',
  );
  void photo;
});

test('the downscaled message keeps both real dimensions', () => {
  assert.equal(
    t('js.common.downscaled', { w: 5600, h: 3730 }),
    'The image was reduced to 5600 × 3730 to fit this device’s memory.',
  );
});

/* ---------- the adaptive pixel budget ---------- */

test('WebKit is detected, and every iOS browser counts as WebKit', () => {
  assert.equal(isWebKitAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'), true);
  assert.equal(isWebKitAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1'), true, 'Chrome on iOS is WebKit');
  assert.equal(isWebKitAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'), true, 'desktop Safari is WebKit');
  assert.equal(isWebKitAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'), false);
  assert.equal(isWebKitAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'), false);
  assert.equal(isWebKitAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'), false, 'Edge is not WebKit');
  assert.equal(isWebKitAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0'), false, 'Opera is not WebKit');
  assert.equal(isWebKitAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15) AppleWebKit/537.36 (KHTML, like Gecko) Firefox/121.0 Safari/537.36'), false, 'Firefox is not WebKit');
  assert.equal(isWebKitAgent(''), false);
});

test('safeMaxPixels caps the budget at the WebKit canvas limit', () => {
  assert.equal(safeMaxPixels(DEFAULT_MAX_PIXELS, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), WEBKIT_SAFE_MAX_PIXELS);
  assert.equal(safeMaxPixels(DEFAULT_MAX_PIXELS, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'), DEFAULT_MAX_PIXELS, 'a desktop keeps the configured budget');
  assert.equal(safeMaxPixels(5_000_000, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)'), 5_000_000, 'a smaller configured budget still wins');
  assert.equal(safeMaxPixels(null, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)'), WEBKIT_SAFE_MAX_PIXELS, 'a nonsense budget falls back to the safe cap');
  assert.equal(safeMaxPixels(), DEFAULT_MAX_PIXELS, 'with no user agent the configured budget applies');
});

test('fitToPixelBudget scales to fit and keeps the aspect ratio', () => {
  // sqrt(16_700_000 / 48_000_000) ≈ 0.5898, floored on both axes so the product stays under the cap.
  assert.deepEqual(fitToPixelBudget(8000, 6000, 16_700_000), { width: 4718, height: 3539, scaled: true });
  assert.deepEqual(fitToPixelBudget(4000, 3000, 16_700_000), { width: 4000, height: 3000, scaled: false });
  // A panorama comes down to something that fits without collapsing.
  const panorama = fitToPixelBudget(20000, 1000, 16_700_000);
  assert.ok(panorama.scaled);
  assert.ok(panorama.width * panorama.height <= 16_700_000);
  assert.ok(panorama.width >= 1 && panorama.height >= 1);
});

test('assertPixelBudget defaults to the platform budget and still refuses the enormous', () => {
  // In Node there is no navigator, so the configured budget applies — which is what the pure
  // engine tests rely on.
  assert.doesNotThrow(() => assertPixelBudget(4000, 3000));
  assert.throws(() => assertPixelBudget(20_000, 20_000), (error) => error instanceof CompressError && error.code === 'IMAGE_TOO_LARGE');
});

/* ---------- compressFile on a WebKit device ---------- */

/** A stand-in for browser-image-compression, returning a blob of the size it is asked for. */
function fakeEncoder(file, options) {
  const blob = new Blob([new Uint8Array(64 * 1024)], { type: options.fileType });
  return Object.assign(blob, { name: file?.name ?? 'out' });
}

function probeWith(width, height) {
  return async () => ({ width, height });
}

test('compressFile shrinks a WebKit-oversized photo to the canvas limit and reports the real size', async () => {
  const ios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
  const file = Object.assign(new Blob([new Uint8Array(4_000_000)], { type: 'image/jpeg' }), { name: 'photo.jpg' });

  const result = await compressFile(
    file,
    { userAgent: ios },
    { imageCompression: fakeEncoder, probeSize: probeWith(8000, 6000) },
  );

  assert.equal(result.meta.downscaled, true, 'a 48 MP photo does not fit an iOS canvas');
  assert.equal(result.meta.width, 4718);
  assert.equal(result.meta.height, 3539);
  assert.equal(result.meta.scaled, true);
  assert.equal(result.meta.sourceWidth, 8000);
  assert.equal(result.meta.sourceHeight, 6000);
  assert.equal(result.meta.budgetPixels, WEBKIT_SAFE_MAX_PIXELS);
});

test('compressFile still refuses an image past the configured budget on a non-WebKit browser', async () => {
  const file = Object.assign(new Blob([new Uint8Array(4_000_000)], { type: 'image/jpeg' }), { name: 'photo.jpg' });
  await assert.rejects(
    () => compressFile(file, {}, { imageCompression: fakeEncoder, probeSize: probeWith(20_000, 20_000) }),
    (error) => error instanceof CompressError && error.code === 'IMAGE_TOO_LARGE',
  );
});

/* ---------- the Photos-friendly copy and the batch gate ---------- */

test('the newer in-app browsers are detected, and iOS Safari still is not one', () => {
  assert.equal(isInAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Line/16.0.1'), true, 'Line');
  assert.equal(isInAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 KAKAOTALK 9.7.0'), true, 'KakaoTalk');
  assert.equal(isInAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 NaverSearchApp 3.0.0'), true, 'Naver');
  assert.equal(isInAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Snapchat 12.80.0.48'), true, 'Snapchat');
  assert.equal(isInAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.53.94;fb_iab/...]'), true, 'fb_iab');
  assert.equal(isInAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'), false, 'Safari itself');
});

/* ---------- the Photos-friendly copy and the batch gate ---------- */

/** Node 21+ owns `navigator` as a read-only getter, so it is stubbed through a descriptor. */
function stubGlobal(name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  };
}

test('a Photos-friendly copy is only baked where it can help', async () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
  const desktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const restoreNav = stubGlobal('navigator', { userAgent: '' });

  // Formats Photos already accepts never ask for a copy, anywhere.
  for (const ua of ['', desktop, iphone]) {
    stubGlobal('navigator', { userAgent: ua });
    assert.equal(await primePhotosVariant({ blob: new Blob([new Uint8Array(64)], { type: 'image/jpeg' }), filename: 'a.jpg' }), null, `JPEG needs no copy on "${ua}"`);
    assert.equal(await primePhotosVariant({ blob: new Blob([new Uint8Array(64)], { type: 'image/png' }), filename: 'a.png' }), null, `PNG needs no copy on "${ua}"`);
    assert.equal(await primePhotosVariant({ blob: new Blob([new Uint8Array(64)], { type: 'application/pdf' }), filename: 'a.pdf' }), null, `a document is not an image on "${ua}"`);
  }

  // A WebP on a desktop is fine as it is; a WebP on iOS wants a copy, but a platform with no
  // bitmap decoder keeps the original rather than promising a file it cannot bake.
  stubGlobal('navigator', { userAgent: desktop });
  assert.equal(await primePhotosVariant({ blob: new Blob([new Uint8Array(64)], { type: 'image/webp' }), filename: 'a.webp' }), null, 'WebP is saveable off iOS');
  stubGlobal('navigator', { userAgent: iphone });
  const restoreBitmap = stubGlobal('createImageBitmap', undefined);
  try {
    assert.equal(await primePhotosVariant({ blob: new Blob([new Uint8Array(64)], { type: 'image/webp' }), filename: 'a.webp' }), null, 'no decoder means the original stands');
  } finally {
    restoreBitmap();
  }

  restoreNav();
});

test('a batch becomes the caller’s ZIP everywhere iOS cannot save one', async () => {
  const entries = [
    { blob: new Blob([new Uint8Array(64)], { type: 'image/webp' }), filename: 'a.webp' },
    { blob: new Blob([new Uint8Array(64)], { type: 'image/jpeg' }), filename: 'b.jpg' },
  ];
  // No navigator stub here, so this is not iOS: the share sheet is not offered and the ZIP is built.
  assert.equal(await saveBatchOrZip({ entries }), null);
  assert.equal(await saveBatchOrZip({ entries: [] }), null, 'an empty batch is nothing to share');
});

test('the swipeable viewer’s counter reads n of total', () => {
  assert.equal(t('js.webview.counter', { n: 3, total: 12 }), '3 / 12');
});
