import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const base = process.argv[2] || 'http://127.0.0.1:4317';
const widths = [390, 768, 820, 899, 900, 1440];
const errors = [];
const externalRequests = [];
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
context.on('request', (request) => {
  const origin = new URL(request.url()).origin;
  if (origin !== new URL(base).origin) externalRequests.push(request.url());
});
const page = await context.newPage();

try {
  for (const locale of ['', '/ar']) {
    await page.goto(base + locale + '/', { waitUntil: 'networkidle' });
    await page.locator('[data-search-controls]').waitFor({ state: 'visible' });
    if (!locale) {
      await page.evaluate(() => localStorage.removeItem('browserimageeditor:favorites'));
      await page.reload({ waitUntil: 'networkidle' });
    }
    if (locale) {
      assert.equal(await page.locator('html').getAttribute('dir'), 'rtl', 'Arabic homepage must be RTL');
      assert.equal(await page.locator('html').getAttribute('lang'), 'ar');
    }
    const firstFavorite = page.locator('.tool-card [data-favorite-toggle]').first();
    const favoriteSlug = await firstFavorite.getAttribute('data-favorite-toggle');
    await firstFavorite.click();
    assert.equal(await firstFavorite.getAttribute('aria-pressed'), 'true', 'favorite should be selected');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('browserimageeditor:favorites'))), [favoriteSlug]);
    await page.locator('[data-category-filter="favorites"]').click();
    assert.equal(await page.locator('.tool-card:visible').count(), 1, 'favorites filter should show saved tools');
    assert.equal(await page.locator('.tool-card:visible [data-favorite-toggle]').getAttribute('data-favorite-toggle'), favoriteSlug);
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('.tool-card [data-favorite-toggle]').first().getAttribute('aria-pressed'), 'true', 'favorite should persist after reload');
    await page.locator('[data-category-filter="optimize"]').click();
    assert.ok(await page.locator('.tool-card:visible').count() >= 1, 'category filter should show matching tools');
    const selectedFavorite = page.locator('[data-favorite-toggle="' + favoriteSlug + '"]');
    await selectedFavorite.click();
    assert.equal(await selectedFavorite.getAttribute('aria-pressed'), 'false', 'favorite should be removable');
    await page.locator('[data-category-filter="all"]').click();
    await page.locator('#tool-search').fill('PDF');
    assert.ok(await page.locator('.tool-card:visible').count() >= 1, 'search should find PDF');
    await page.locator('#tool-search').fill('xxxxxxxx-no-match');
    assert.equal(await page.locator('.tool-card:visible').count(), 0);
    await page.locator('[data-search-clear]').click();
    assert.ok(await page.locator('.tool-card:visible').count() >= 6);

    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        'home overflow ' + locale + ' at ' + width,
      );
    }

    await page.setViewportSize({ width: 899, height: 844 });
    const menu = page.locator('[data-mobile-menu-toggle]');
    assert.ok(await menu.isVisible(), 'mobile menu must be available below 900px');
    await menu.click();
    assert.equal(await menu.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden');
    assert.equal(await page.evaluate(() => document.activeElement?.closest('.nav-sheet') !== null), true, 'opening the menu should move focus into it');
    await page.keyboard.press('Escape');
    assert.equal(await menu.getAttribute('aria-expanded'), 'false', 'Escape should close the menu');
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('[data-mobile-menu-toggle]')), true, 'closing the menu should restore focus');
    await menu.click();
    assert.equal(await menu.getAttribute('aria-expanded'), 'true');
    await page.setViewportSize({ width: 900, height: 844 });
    await page.waitForFunction(() => document.body.style.overflow === '');
    assert.ok(!(await menu.isVisible()), 'desktop navigation must take over at 900px');
  }

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + '/tools/compress-image/', { waitUntil: 'networkidle' });
  await page.locator('[data-sample-image]').click();
  await page.locator('[data-result]:not([hidden])').waitFor({ timeout: 30000 });
  await page.locator('.next-tool select').selectOption('resize-image');
  const opened = context.waitForEvent('page');
  await page.locator('.next-tool button').click();
  const next = await opened;
  await next.waitForLoadState('load');
  await next.locator('[data-result]:not([hidden])').waitFor({ timeout: 30000 });
  assert.equal(new URL(next.url()).hash, '', 'handoff token must be consumed');
  assert.ok(
    await next.evaluate(async () => {
      const link = document.querySelector('[data-download]');
      return Boolean(link?.href.startsWith('blob:') && (await (await fetch(link.href)).blob()).size > 0);
    }),
    'same-origin handoff should process a non-empty image',
  );
  await next.close();

  await page.setViewportSize({ width: 390, height: 844 });
  for (const tool of ['convert-image', 'crop-image', 'image-to-pdf', 'enhance-photo']) {
    await page.goto(base + '/tools/' + tool + '/', { waitUntil: 'networkidle' });
    await page.locator('[data-dropzone-input]').waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-dropzone-input]').disabled);
    await page.locator('[data-sample-image]').click();
    if (tool === 'crop-image') await page.locator('[data-crop-apply]').click({ timeout: 10000 });
    if (tool === 'image-to-pdf') await page.locator('[data-build-pdf]').click({ timeout: 10000 });
    await page.locator('[data-result]:not([hidden])').waitFor({ timeout: 30000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'tool overflow ' + tool);
  }

  await page.goto(base + '/ar/tools/compress-image/', { waitUntil: 'networkidle' });
  await page.locator('[data-sample-image]').click();
  await page.locator('[data-result]:not([hidden])').waitFor({ timeout: 30000 });
  assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
  assert.equal(await page.locator('html').getAttribute('lang'), 'ar');
  const status = await page.locator('[data-status][role="status"]').textContent();
  assert.ok(!/js\.[a-z0-9_.-]+/i.test(status || ''), 'runtime status must not expose translation keys');
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  assert.deepEqual(externalRequests, [], 'image tools must not send requests to third-party origins');
  console.log('PASS: EN/AR search, categories, persistent local favorites, 390/768/820/899/900/1440 responsive checks, 900px menu boundary, keyboard focus and Escape restore, local image processing, in-memory handoff, no external requests or runtime errors.');
} finally {
  await browser.close();
}
