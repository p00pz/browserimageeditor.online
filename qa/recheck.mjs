/** Re-verifies the four fixes from the audit round, numerically.
 * 1. resize honours the dimensions it is given (was reading the "original" chip's empty value).
 * 2. convert's compare slider no longer covers the viewport.
 * 3. the file input keeps an accessible name once a file is loaded (.dropzone-more restored).
 * 4. a selected chip's text clears 4.5:1, and the browse pill's text is legible on its own fill.
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:4317';

function image(ctx, w, h) {
  return (async () => {
    const page = await ctx.newPage();
    const url = await page.evaluate((dim) => {
      const c = document.createElement('canvas'); c.width = dim[0]; c.height = dim[1];
      const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, c.width, c.height);
      g.addColorStop(0, '#0a84ff'); g.addColorStop(1, '#ff2d55');
      x.fillStyle = g; x.fillRect(0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    }, [w, h]);
    await page.close();
    return { name: 'sample.png', mimeType: 'image/png', buffer: Buffer.from(url.split(',')[1], 'base64') };
  })();
}

(async () => {
  const browser = await chromium.launch();
  const problems = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ar-SA' });

  // --- 1. resize ---
  {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/ar/tools/resize-image/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await page.locator('input[type="file"]').first().setInputFiles(await image(ctx, 2400, 1600));
    await page.waitForTimeout(1500);
    // The root-cause test: click a NON-square preset chip. Before the fix, applyPreset wrote the
    // width then the height onto the same element (the "original" chip, matched first by a bare
    // [data-width]), so height won and both fields read 566. Now they must read 1080 and 566.
    const chip = page.locator('.chip', { hasText: 'منشور عرضي' }).first();
    await chip.click();
    await page.waitForTimeout(400);
    const vals = await page.evaluate(() => ({
      width: document.querySelector('input[data-width]')?.value,
      height: document.querySelector('input[data-height]')?.value,
    }));
    console.log(`resize: landscape preset -> width=${vals.width} height=${vals.height} (expect 1080 / 566)`);
    if (vals.width !== '1080' || vals.height !== '566') {
      problems.push(`resize: non-square preset still writes one value into both fields: ${JSON.stringify(vals)}`);
    }
    // The ratio lock derives height from a typed width; it was inert before the fix. Test it with
    // the boxes enabled: clearing the preset select is what unlocks them.
    await page.evaluate(() => {
      const select = document.querySelector('[data-preset]');
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(300);
    const widthInput = page.locator('input[data-width]');
    await widthInput.fill('1920');
    await widthInput.dispatchEvent('input');
    const derived = await page.locator('input[data-height]').inputValue().catch(() => '?');
    console.log(`resize: typed 1920 with ratio lock -> derived height=${derived} (expect 1280)`);
    if (derived !== '1280') problems.push(`resize: ratio lock did not derive height from the typed width (got ${derived})`);
    await page.close();
  }

  // --- 2. convert slider geometry ---
  {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/ar/tools/convert-image/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await page.locator('input[type="file"]').first().setInputFiles(await image(ctx, 1200, 900));
    await page.waitForTimeout(1500);
    const geo = await page.evaluate(() => {
      const container = document.querySelector('[data-compare]');
      const pane = document.querySelector('.compare-slider-pane');
      const chip = document.querySelector('.chip[aria-checked="true"]') || document.querySelector('.chip');
      const cr = chip.getBoundingClientRect();
      const at = document.elementFromPoint(cr.x + cr.width / 2, cr.y + cr.height / 2);
      return {
        containerH: container ? Math.round(container.getBoundingClientRect().height) : -1,
        paneBox: pane ? Array.from(pane.getBoundingClientRect(), (v) => Math.round(v)).join(',') : 'none',
        hitAtChip: at ? at.className?.toString().slice(0, 40) : 'null',
      };
    });
    console.log(`convert: ${JSON.stringify(geo)}`);
    if (geo.containerH <= 2) problems.push('convert: compare container is 0px tall');
    if (geo.paneBox.startsWith('0,0')) problems.push(`convert: pane still covers the viewport (${geo.paneBox})`);
    if (geo.hitAtChip.includes('compare-slider-pane')) problems.push('convert: the pane still swallows the chip hit');
    await page.close();
  }

  // --- 3. the input's accessible name after load ---
  {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/ar/tools/compress-image/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await page.locator('input[type="file"]').first().setInputFiles(await image(ctx, 900, 700));
    await page.waitForTimeout(1500);
    const name = await page.evaluate(() => {
      const input = document.querySelector('[data-dropzone-input]');
      const more = document.querySelector('.dropzone-more');
      const acc = window.__acc || (() => null);
      return {
        ariaLabel: input.getAttribute('aria-label'),
        moreVisible: more ? getComputedStyle(more).display !== 'none' : 'absent',
        moreText: more?.textContent?.trim().slice(0, 30),
      };
    });
    console.log(`input name: ${JSON.stringify(name)}`);
    if (name.moreVisible === 'absent') problems.push('input: .dropzone-more is missing from the markup again');
    else if (name.moreVisible === false || name.moreVisible === 'none')
      problems.push('input: .dropzone-more is display:none after load, so the input has no visible label');
    await page.close();
  }

  // --- 4. contrast of the two fixed fills ---
  {
    const page = await ctx.newPage();
    for (const theme of ['light', 'dark']) {
      await page.addInitScript((t) => { try { localStorage.setItem('browserimageeditor:theme', t); } catch (e) {} }, theme);
      await page.goto(`${BASE}/ar/tools/compress-image/`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      await page.locator('input[type="file"]').first().setInputFiles(await image(ctx, 900, 700));
      await page.waitForTimeout(1500);
      const ratios = await page.evaluate(() => {
        const lum = (c) => {
          const m = c.match(/\d+(\.\d+)?/g)?.map(Number) || [0, 0, 0];
          const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
          return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]);
        };
        const ratio = (el) => {
          const cs = getComputedStyle(el);
          const bg = cs.backgroundColor;
          return (1.05 / (lum(bg) + 0.05)).toFixed(2);
        };
        const chip = document.querySelector('.chip[aria-checked="true"]');
        const browse = document.querySelector('.dropzone-browse');
        return { selectedChip: chip ? ratio(chip) : 'absent', browse: browse ? ratio(browse) : 'absent' };
      });
      console.log(`${theme}: white-on-fill contrast = ${JSON.stringify(ratios)}`);
      for (const [k, v] of Object.entries(ratios)) {
        if (v !== 'absent' && parseFloat(v) < 4.5) problems.push(`${theme}: ${k} is ${v}:1, below 4.5`);
      }
      await page.evaluate(() => localStorage.clear());
    }
    await page.close();
  }

  await browser.close();
  console.log('');
  console.log(problems.length ? `RECHECK FAILURES (${problems.length})` : 'RECHECK PASS');
  for (const p of problems) console.log('  x', p);
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
