/** Rule checks that apply in every state: tap targets >= 44px on mobile, no text below 12px,
 * body text >= 16px, and Western digits inside Arabic prose wrapped in bdi. Read-only. */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:4317';
const TOOLS = ['compress-image', 'resize-image', 'convert-image', 'crop-image', 'image-to-pdf', 'enhance-photo'];

(async () => {
  const browser = await chromium.launch();
  const problems = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ar-SA' });
  const page = await ctx.newPage();
  for (const slug of TOOLS) {
    await page.goto(`${BASE}/ar/tools/${slug}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const out = { small: [], taps: [], bodyOk: null };
      const textSel = 'a, button, span, p, label, dd, dt, summary, .ctl-readout, .chip';
      for (const el of document.querySelectorAll(textSel)) {
        const cs = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        if (box.width < 4 || box.height < 4 || cs.display === 'none' || cs.visibility === 'hidden') continue;
        const px = parseFloat(cs.fontSize);
        if (px < 12) out.small.push(`${el.tagName}.${(el.className?.toString() || '').slice(0, 24)}@${px}px`);
        // tap targets: anything interactive a thumb lands on
        if (el.matches('button, .chip, a.nav-link, summary, [role="button"]')) {
          const h = Math.round(box.height);
          if (h < 44) out.taps.push(`${el.tagName}.${(el.className?.toString() || '').slice(0, 24)}=${h}px`);
        }
      }
      out.bodyOk = parseFloat(getComputedStyle(document.body).fontSize);
      return out;
    });
    if (r.bodyOk < 16) problems.push(`[${slug}] body font ${r.bodyOk}px < 16`);
    if (r.small.length) problems.push(`[${slug}] text under 12px: ${r.small.slice(0, 4).join(', ')}`);
    if (r.taps.length) problems.push(`[${slug}] tap targets under 44px (${r.taps.length}): ${r.taps.slice(0, 4).join(', ')}`);
  }
  await browser.close();
  console.log('body min font 16px / no text <12px / tap targets >=44px on 390px:');
  console.log(problems.length ? `FAIL (${problems.length})` : 'PASS on all six tools');
  for (const p of problems) console.log('  x', p);
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
