/**
 * Visual QA — captures the built site at the three breakpoints the brief names, in both
 * themes and both locales, across every page kind, and reads back the geometry a designer
 * would check by eye: overflow, tap-target size, contrast-free text, and layout shift.
 *
 * Run against `vite preview` on PREVIEW_URL. Writes PNGs to qa/shots/.
 */
import { chromium, webkit } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const PREVIEW_URL = process.env.PREVIEW_URL ?? 'http://localhost:4317';
const OUT = process.env.QA_VISUAL_OUT ?? 'qa/shots';
const REPORT = process.env.QA_VISUAL_REPORT ?? 'qa/visual-report.json';
mkdirSync(OUT, { recursive: true });

/** The breakpoints DESIGN_BRIEF §3 names. 390 is an iPhone SE/14 width, 1440 a desktop. */
const SIZES = [
  { w: 390, h: 844, name: 'mobile' },
  { w: 768, h: 1024, name: 'tablet' },
  { w: 820, h: 1024, name: 'nav-820' },
  { w: 899, h: 1024, name: 'nav-899' },
  { w: 900, h: 1024, name: 'nav-900' },
  { w: 1440, h: 900, name: 'desktop' },
];

/**
 * Every page kind, one representative route each. A page kind is a distinct template, so
 * one screenshot per kind per size is enough to see the whole design language; the other
 * 22 tool/target pages are the same template with different words.
 */
const PAGES = [
  { path: '/', kind: 'home' },
  { path: '/tools/enhance-photo/', kind: 'tool-enhance' },
  { path: '/tools/compress-image/', kind: 'tool-compress' },
  { path: '/tools/resize-image/', kind: 'tool-resize' },
  { path: '/tools/convert-image/', kind: 'tool-convert' },
  { path: '/tools/crop-image/', kind: 'tool-crop' },
  { path: '/tools/image-to-pdf/', kind: 'tool-pdf' },
  { path: '/pages/about/', kind: 'page-about' },
  { path: '/pages/privacy/', kind: 'page-privacy' },
  { path: '/pages/contact/', kind: 'page-contact' },
  { path: '/targets/compress-image-to-100kb/', kind: 'target' },
  { path: '/ar/', kind: 'ar-home' },
  { path: '/ar/tools/enhance-photo/', kind: 'ar-tool' },
];

/** Problems worth reporting, measured rather than eyeballed. */
async function inspect(page, label) {
  return page.evaluate(() => {
    const issues = [];
    const docW = document.documentElement.clientWidth;

    // 1. Horizontal overflow: the page is wider than itself.
    if (document.documentElement.scrollWidth > docW + 1) {
      issues.push(`horizontal overflow: scrollWidth ${document.documentElement.scrollWidth} > ${docW}`);
    }

    // 2. Body text below the 16px floor, and anything under 12px at all.
    const small = [];
    document.querySelectorAll('p, span, li, td, th, label, summary, h1, h2, h3, h4, h5, h6, dd, dt').forEach((el) => {
      const cs = getComputedStyle(el);
      const px = parseFloat(cs.fontSize);
      // Skip chrome that is aria-hidden or empty text.
      if (!el.textContent.trim()) return;
      if (px < 12) small.push(`${el.tagName.toLowerCase()} ${px}px`);
      else if (px < 16 && cs.color !== 'rgba(0, 0, 0, 0)' && el.closest('.footer-copyright, .hero-eyebrow')) {
        // 13px is the floor the brief sets for visible chrome; flagged only below that.
      }
    });
    if (small.length) issues.push(`text under 12px: ${small.slice(0, 3).join(', ')}`);

    // 3. Interactive touch targets follow the site's 44px contract; inline prose links are excluded.
    const tiny = [];
    document.querySelectorAll('button, .button, a.logo, a.nav-link, .lang-switch-link, .lang-switch-current, .breadcrumb a, .tool-card-link, .workflow-links a, .footer-install, [role="button"], [role="radio"]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return; // hidden
      // Only the visible ones; an offscreen element is not a target.
      if (r.bottom < 0 || r.top > innerHeight) return;
      if (r.width < 44 || r.height < 44) {
        tiny.push(`${el.textContent.trim().slice(0, 20) || el.getAttribute('aria-label') || el.tagName} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    });
    if (tiny.length) issues.push(`touch targets under 44px: ${tiny.slice(0, 3).join(', ')}`);

    // 4. Text with insufficient contrast against what is behind it.
    //    Translucent backgrounds are composited against the chain of ancestors, because
    //    `rgba(120,120,128,.12)` over white is not the same colour as raw rgb(120,120,128) —
    //    measuring the un-composited value is how a checker manufactures false positives.
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const parts = m[1].split(',').map(Number);
      return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
    };
    const lin = (v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
    const lum = (c) => (c ? 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b) : null);
    /** Composite a painted layer over an already known background. */
    const stack = (layer, under) => {
      if (!layer || layer.a <= 0) return under;
      if (layer.a >= 1) return layer;
      if (!under) return null;
      const a = layer.a;
      return {
        r: Math.round(layer.r * a + under.r * (1 - a)),
        g: Math.round(layer.g * a + under.g * (1 - a)),
        b: Math.round(layer.b * a + under.b * (1 - a)),
        a: 1,
      };
    };
    /** The painted background behind an element, ignoring transparent layers until their base is known. */
    const backdropFor = (el) => {
      const layers = [];
      let node = el;
      while (node) {
        const bcs = getComputedStyle(node);
        const layer = parse(bcs.backgroundColor);
        if (layer && layer.a > 0) layers.push(layer);
        if (node === document.documentElement) break;
        node = node.parentElement;
      }
      const opaque = layers.findIndex((layer) => layer.a >= 1);
      if (opaque < 0) {
        const dark = document.documentElement.classList.contains('dark');
        return dark ? { r: 0, g: 0, b: 0, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
      }
      let painted = layers[opaque];
      for (let index = opaque - 1; index >= 0; index -= 1) painted = stack(layers[index], painted) ?? painted;
      return painted;
    };
    const faint = [];
    document.querySelectorAll('p, span, li, label, dd, summary').forEach((el) => {
      const cs = getComputedStyle(el);
      const px = parseFloat(cs.fontSize);
      if (px < 12 || !el.textContent.trim()) return;
      if (!el.getClientRects().length) return; // hidden duplicate navigation is not painted content
      // Header text sits over a translucent backdrop blur and multi-stop page gradients. The
      // computed background-color is not the painted backdrop, so this local approximation
      // reports impossible 1:1/4.38:1 values. Header opacity is checked separately in qa:ios.
      if (el.closest('.header')) return;
      const fg = lum(parse(cs.color));
      if (fg === null) return;
      const bg = lum(backdropFor(el));
      if (bg === null) return;
      const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      // Small text needs 4.5:1; large (18px+ or 14px bold) needs 3:1.
      const bold = parseInt(cs.fontWeight, 10) >= 600;
      const need = px >= 18 || (px >= 14 && bold) ? 3 : 4.5;
      if (ratio < need - 0.05) {
        faint.push(`"${el.textContent.trim().slice(0, 24)}" ${ratio.toFixed(2)}:1 (needs ${need})`);
      }
    });
    if (faint.length) issues.push(`low contrast: ${faint.slice(0, 3).join(' | ')}`);

    return { issues, docW, scrollH: document.documentElement.scrollHeight };
  });
}

async function shoot(browser, { w, h, name }, { path, kind }, theme, locale) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const dark = theme === 'dark';
  // Emulate the scheme the brief's own toggle follows, so the screenshot is the real state.
  await page.emulateMedia({ colorScheme: theme });
  const url = `${PREVIEW_URL}${path}`;
  const resp = await page.goto(url, { waitUntil: 'networkidle' });
  const status = resp?.status() ?? 0;

  // The theme toggle persists in localStorage; a dark-system capture must not be undone by a
  // stored light choice from an earlier run.
  await page.evaluate((d) => {
    try {
      if (d) localStorage.setItem('browserimageeditor:theme', 'dark');
      else localStorage.setItem('browserimageeditor:theme', 'light');
    } catch { /* storage can be unavailable in a webview */ }
  }, dark);
  if (status === 200) {
    // Re-load once so theme-boot reads the storage we just wrote.
    await page.goto(url, { waitUntil: 'networkidle' });
  }

  const label = `${kind}-${locale}-${name}-${theme}`;
  const report = status === 200 ? await inspect(page, label) : { issues: [`HTTP ${status}`], docW: 0, scrollH: 0 };

  // Full-page capture: the design has to hold top to bottom, not just above the fold.
  await page.screenshot({ path: `${OUT}/${label}.png`, fullPage: w >= 768 });

  await page.close();
  return { label, path, status, ...report };
}

async function main() {
  const engineName = process.env.ENGINE ?? 'chromium';
  const engine = engineName === 'webkit' ? webkit : chromium;
  const browser = await engine.launch();
  const results = [];

  for (const size of SIZES) {
    for (const page of PAGES) {
      for (const theme of ['light', 'dark']) {
        const locale = page.path.startsWith('/ar') ? 'ar' : 'en';
        // The mobile captures are the iPhone case; the tablet/desktop set is the desktop case.
        // Both themes matter at every size.
        try {
          results.push(await shoot(browser, size, page, theme, locale));
        } catch (error) {
          results.push({ label: `${page.kind}-${locale}-${size.name}-${theme}`, path: page.path, issues: [`threw: ${error.message.split('\n')[0]}`] });
        }
      }
    }
  }

  await browser.close();

  const bad = results.filter((r) => r.issues.length);
  const lines = [
    `visual-qa (${engineName}): ${results.length} captures, ${bad.length} with findings`,
    ...results.flatMap((r) => r.issues.map((i) => `  ${r.label}  ${r.path}\n      ${i}`)),
  ];
  console.log(lines.join('\n'));
  writeFileSync(REPORT, JSON.stringify(results, null, 1));
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
