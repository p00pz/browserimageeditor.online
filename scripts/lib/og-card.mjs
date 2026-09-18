/**
 * The social card model and its template — pure data, no renderer.
 *
 * `ogCards()` says which cards exist and what text goes on them; `ogCardTree()` builds the layout
 * as a satori element tree (plain objects, React-shaped but without React); `ogTreeToHtml()` renders
 * the same tree to inline-styled HTML so the whole set can be reviewed in a browser without the
 * rasteriser installed.
 *
 * The layout is defined once and consumed twice. That matters more than it sounds: if the preview
 * and the generated image were two templates, they would drift and the preview would start lying.
 *
 * Palette: the dark-mode tokens from src/assets/css/base.css, kept here as literals because a
 * bitmap cannot read a CSS variable — tests/seo.test.js asserts they still match base.css.
 */
export const PALETTE = {
  background: '#0d1117',
  surface: '#161b22',
  border: '#30363d',
  text: '#e6edf3',
  muted: '#6e7681',
  accent: '#58a6ff',
};

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/** The eyebrow shown on each kind of page, so a card says what it is at a glance. */
const EYEBROWS = {
  home: 'Free browser tools',
  tool: 'Tool',
  guide: 'Guide',
  page: 'About this site',
};

/**
 * Title size by length. A fixed rule, not a heuristic per card: three sizes that a reviewer can
 * predict, and long target titles ("Photos to PDF, One Page Each") step down instead of wrapping
 * into four lines.
 */
function titleSize(title) {
  if (title.length <= 48) return 72;
  if (title.length <= 84) return 58;
  return 48;
}

function element(type, style, children) {
  return { type, props: { style, children } };
}

/**
 * Every card the site needs, in a stable order: the homepage, then tools, guides and pages in
 * content order. `locale` only changes the directory the card is filed under today; the copy comes
 * from that locale's content, like every other page.
 */
export function ogCards({ site, locale, tools, targets, pages }) {
  const cards = [];
  const push = (kind, slug, title, description, eyebrow) => {
    cards.push({
      key: slug ? `${kind}-${slug}` : kind,
      kind,
      eyebrow: eyebrow ?? EYEBROWS[kind],
      title,
      description,
    });
  };

  // One card for every page the generators emit, not only the advertised ones: a page's head says
  // `og:image`, so a card that does not exist is a 404 on a real URL. That is why the filters here
  // are about what gets *generated* (every tool, the live guides, every standalone page) rather than
  // about what appears in search results. Non-live guides are excluded because no page is emitted
  // for them at all.
  push('home', null, `${site.name} — ${site.tagline}`, site.description);
  for (const tool of tools) {
    push('tool', tool.slug, tool.name, tool.description);
  }
  for (const target of targets.filter((entry) => entry.status === 'live')) {
    push('guide', target.slug, target.title.split(' — ')[0], target.description);
  }
  for (const page of pages) {
    // The offline fallback is not "About this site", and its card is the one a visitor might see if
    // the URL is ever pasted somewhere.
    push('page', page.slug, page.h1, page.description, page.status === 'utility' ? 'Offline' : undefined);
  }

  return cards;
}

/** The 1200x630 tree satori renders. Same input, same output, every machine. */
export function ogCardTree(card, { site }) {
  const eyebrow = element(
    'div',
    {
      display: 'flex',
      alignItems: 'center',
      border: `2px solid ${PALETTE.border}`,
      borderRadius: '999px',
      padding: '8px 22px',
      fontSize: '22px',
      color: PALETTE.muted,
      letterSpacing: '2px',
      textTransform: 'uppercase',
    },
    [card.eyebrow],
  );

  return element(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      width: `${OG_WIDTH}px`,
      height: `${OG_HEIGHT}px`,
      padding: '72px',
      backgroundColor: PALETTE.background,
      // Must match the family name gen-og.mjs hands to satori, or no glyph is found.
      fontFamily: 'IBM Plex Sans',
    },
    [
      // Wordmark row: a colour block, the site name, and what kind of page this is.
      element('div', { display: 'flex', alignItems: 'center', gap: '20px' }, [
        element('div', {
          width: '44px',
          height: '44px',
          backgroundColor: PALETTE.accent,
          borderRadius: '12px',
        }),
        element(
          'div',
          { display: 'flex', fontSize: '34px', fontWeight: 700, color: PALETTE.text },
          [site.name],
        ),
        element('div', { display: 'flex', marginLeft: '12px' }, [eyebrow]),
      ]),

      // The card's own text. Satori wraps these inside the width, which is the reason a layout
      // engine is worth a build dependency: the alternative is guessing where a line ends.
      element('div', { display: 'flex', flexDirection: 'column' }, [
        element(
          'div',
          {
            display: 'flex',
            fontSize: `${titleSize(card.title)}px`,
            fontWeight: 700,
            lineHeight: 1.15,
            color: PALETTE.text,
            maxWidth: '1000px',
          },
          [card.title],
        ),
        element(
          'div',
          {
            display: 'flex',
            marginTop: '24px',
            fontSize: '30px',
            lineHeight: 1.4,
            color: PALETTE.muted,
            maxWidth: '980px',
          },
          [card.description],
        ),
      ]),

      element('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between' }, [
        element(
          'div',
          { display: 'flex', fontSize: '26px', fontWeight: 600, color: PALETTE.accent },
          ['No uploads. No tracking. 100% in your browser.'],
        ),
        element(
          'div',
          { display: 'flex', fontSize: '24px', color: PALETTE.muted },
          [site.url.replace(/^https?:\/\//, '')],
        ),
      ]),
    ],
  );
}

/* ---------- preview rendering (no dependencies) ---------- */

function cssName(property) {
  return property.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

function styleToCss(style) {
  return Object.entries(style)
    .map(([property, value]) => `${cssName(property)}:${value}`)
    .join(';');
}

function treeToHtml(node) {
  if (typeof node === 'string') return node.replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]);
  const children = (node.props.children ?? []).map(treeToHtml).join('');
  return `<div style="${styleToCss(node.props.style)}">${children}</div>`;
}

/**
 * Renders one card as inline-styled HTML. Used for the preview sheet: the exact same tree the
 * rasteriser gets, so what you see is the layout that ships.
 */
export function ogTreeToHtml(card, { site }) {
  return treeToHtml(ogCardTree(card, { site }));
}
