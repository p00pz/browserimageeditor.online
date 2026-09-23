/**
 * iOS-class verification on real WebKit — the reported bug was seen on a real iPhone, so this
 * runs the save path through the actual tool UI with an iPhone user agent and touch emulation,
 * and checks the chrome defects the owner reported.
 *
 * Serve the built site first:  npx vite preview --port 4317   then   node qa/ios-verify.mjs
 * (A dev server works too — the run is against PREVIEW_URL either way.)
 */
import { webkit } from 'playwright';

const PREVIEW_URL = process.env.PREVIEW_URL ?? 'http://localhost:4317';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1';

const findings = [];
function check(ok, message) {
  findings.push({ ok, message });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
}

async function openMenu(page) {
  await page.click('[data-mobile-menu-toggle]');
  await page.waitForSelector('.nav-sheet.is-open');
}

async function main() {
  const browser = await webkit.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: IPHONE,
    isMobile: true,
    hasTouch: true,
  });
  const requests = [];
  context.on('request', (req) => requests.push(req.url()));

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  const url = `${PREVIEW_URL}/ar/tools/compress-image/`;
  await page.goto(url, { waitUntil: 'networkidle' });

  /* ---------- A. the chrome the owner reported ---------- */

  const headerAlpha = await page.evaluate(() => {
    const header = document.querySelector('.header');
    if (!header) return null;
    const m = getComputedStyle(header).backgroundColor.match(/([\d.]+)\)\s*$/);
    return m ? parseFloat(m[1]) : null;
  });
  check(headerAlpha !== null && headerAlpha >= 0.9, `header background alpha is ${headerAlpha} (needs >= 0.9, no text bleed)`);

  // The header switch leaves the layout on a phone; the sheet carries it.
  const headerSwitch = await page.locator('.header-inner > .lang-switch').evaluate((el) => getComputedStyle(el).display).catch(() => 'absent');
  check(headerSwitch === 'none', `header language switch is hidden on a phone (display: ${headerSwitch})`);

  await openMenu(page);
  const sheetSwitch = await page.locator('.nav-sheet > .lang-switch').count();
  check(sheetSwitch === 1, `the menu sheet carries the language switch (${sheetSwitch} found)`);

  const overflowLocked = await page.evaluate(() => document.body.style.overflow);
  check(overflowLocked === 'hidden', `page scroll is locked while the sheet is open (overflow: ${overflowLocked})`);

  const sheetAlpha = await page.evaluate(() => {
    const sheet = document.querySelector('.nav-sheet.is-open');
    const m = getComputedStyle(sheet).backgroundColor.match(/([\d.]+)\)\s*$/);
    return m ? parseFloat(m[1]) : null;
  });
  check(sheetAlpha !== null && sheetAlpha >= 0.9, `sheet background alpha is ${sheetAlpha} (needs >= 0.9, heavily frosted)`);

  // Esc closes it and frees the page. (`.nav-sheet` is display:none when closed, so the wait is on
  // the class, not on visibility.)
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.nav-sheet').classList.contains('is-open'));
  const overflowFreed = await page.evaluate(() => document.body.style.overflow);
  check(overflowFreed === '', `Escape closes the sheet and restores scrolling (overflow: ${overflowFreed})`);

  // The switch resolves its href from this page's own alternate.
  const resolvedHref = await page
    .locator('.nav-sheet [data-lang-target]').first()
    .evaluate((link) => link.getAttribute('href'))
    .catch(() => null);
  check(
    resolvedHref !== null && resolvedHref.includes('compress-image') && resolvedHref !== '/',
    `the sheet's English link points at this page's counterpart, got "${resolvedHref}"`,
  );

  /* ---------- B. the save path, end to end ---------- */

  await page.click('[data-sample-image]');

  // The default operation runs the moment an image lands; the result panel is the signal.
  await page.waitForSelector('[data-result]:not([hidden])', { timeout: 45000 });
  const downloadLabel = await page.locator('[data-download]').first().textContent();
  check(!!downloadLabel && /KB|MB|B/.test(downloadLabel), `the save button carries the real size: "${downloadLabel}"`);

  // The Photos-friendly copy should have been primed (compress defaults to WebP on iOS).
  const primed = await page.evaluate(() => {
    const pre = document.querySelector('pre.save-debug');
    return pre ? pre.textContent : null;
  });

  await page.click('[data-download]');

  // Headless WebKit has no share sheet, so an iPhone UA takes the fallback viewer by design.
  await page.waitForSelector('.save-viewer:not([hidden])', { timeout: 8000 });

  const viewer = await page.evaluate(async () => {
    const img = document.querySelector('.save-viewer-img');
    if (!img) return { missing: true };
    const cs = getComputedStyle(img);
    let callout = cs.getPropertyValue('-webkit-touch-callout') || cs.webkitTouchCallout;
    if (!callout) {
      // Linux WebKit does not expose this iOS-only property through computed style. Verify the
      // production stylesheet declaration, rather than treating unsupported CSSOM as a failure.
      for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
        const css = await fetch(link.href).then((response) => response.text()).catch(() => '');
        if (/\.save-viewer-img\s*\{[^}]*-webkit-touch-callout\s*:\s*auto\s*;/s.test(css)) callout = 'auto';
      }
    }
    const r = img.getBoundingClientRect();
    const header = document.querySelector('.header').getBoundingClientRect();
    // elementFromPoint at the image's centre: whatever is on top of the pixels.
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      callout,
      userSelect: cs.userSelect,
      userDrag: cs.webkitUserDrag,
      isImg: top === img,
      elementOnTop: top ? top.className || top.tagName : null,
      belowHeader: r.top >= header.bottom - 1,
      headerHeight: Math.round(header.height),
      viewerTop: Math.round(r.top),
    };
  });
  check(viewer.callout === 'auto', `-webkit-touch-callout on the viewer image is "${viewer.callout}" (the reported bug was "none")`);
  check(viewer.userSelect !== 'none' && viewer.userDrag !== 'none', `selection and drag are enabled on the viewer image (select="${viewer.userSelect}", drag="${viewer.userDrag}")`);
  check(viewer.isImg, `nothing is layered over the image (elementFromPoint at centre: "${viewer.elementOnTop}")`);
  check(viewer.belowHeader, `the viewer starts below the header (top ${viewer.viewerTop} vs header bottom ${viewer.headerHeight + Math.round(viewer.viewerTop)})`);

  const openInSafariVisible = await page.locator('.save-viewer-open').isVisible();
  check(!openInSafariVisible, `"Open in Safari" is not offered in Safari itself (visible: ${openInSafariVisible})`);

  const hint = await page.locator('.save-viewer-hint').textContent();
  check(!!hint && hint.includes('مطولاً'), `the long-press hint reads naturally in Arabic: "${hint}"`);

  // The page behind the viewer is locked too.
  const viewerOverflow = await page.evaluate(() => document.body.style.overflow);
  check(viewerOverflow === 'hidden', `the page is scroll-locked while the viewer is open (overflow: ${viewerOverflow})`);

  await page.keyboard.press('Escape');
  await page.waitForSelector('.save-viewer[hidden], .save-viewer', { state: 'detached' }).catch(() => {});

  /* ---------- C. ?debug=1 diagnostics ---------- */

  await page.goto(`${url}?debug=1`, { waitUntil: 'networkidle' });
  await page.click('[data-sample-image]');
  await page.waitForSelector('[data-result]:not([hidden])', { timeout: 45000 });
  await page.click('[data-download]');
  await page.waitForSelector('pre.save-debug', { timeout: 8000 });
  const debug = await page.evaluate(() => document.querySelector('pre.save-debug').textContent);
  check(
    debug.includes('"blobType"') && debug.includes('"sharedType"') && debug.includes('"ua"'),
    `?debug=1 pins a diagnostics trace with the blob type, the shared type and the user agent`,
  );

  /* ---------- D. network and console ---------- */

  const thirdParty = requests.filter((u) => {
    const host = (() => {
      try {
        return new URL(u).host;
      } catch {
        return null;
      }
    })();
    return host && host !== 'localhost:4317' && host !== '127.0.0.1:4317';
  });
  check(thirdParty.length === 0, `no third-party request left the page (${thirdParty.length} found${thirdParty.length ? ': ' + thirdParty.slice(0, 3).join(', ') : ''})`);
  check(errors.length === 0, `no page console errors (${errors.length}${errors.length ? ': ' + errors[0].slice(0, 120) : ''})`);

  await browser.close();

  const failed = findings.filter((f) => !f.ok).length;
  console.log(`\nios-verify: ${findings.length} checks, ${failed} failing`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
