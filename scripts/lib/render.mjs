/**
 * Build-time rendering helpers: a deliberately tiny {{token}} template engine, the
 * generated-file banner, a writer that skips unchanged files so re-running the generators is a
 * no-op, and the placeholder audit that keeps guessed facts from shipping quietly.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { srcDir } from './content.mjs';

const TOKEN_PATTERN = /\{\{\{([A-Za-z0-9_.-]+)\}\}\}|\{\{([A-Za-z0-9_.-]+)\}\}/g;
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Everything a page can contain that means "a human still has to fill this in". The first is an
 * explicit marker authors write on purpose; the second catches placeholder addresses and URLs
 * that would otherwise look like real ones.
 */
const PLACEHOLDER_PATTERNS = [
  { kind: 'TO-CONFIRM marker', pattern: /TO CONFIRM/g },
  {
    kind: 'example domain',
    pattern: /[A-Za-z0-9._%+-]+@example\.[a-z]{2,}|https?:\/\/example\.[a-z]{2,}/g,
  },
];

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

/**
 * Replaces `{{token}}` with an HTML-escaped value and `{{{token}}}` with a raw value.
 * A token with no matching key is a build failure rather than a blank space, so a
 * typo in a template can never silently ship an empty <title> or h1.
 *
 * Substituted values are not re-scanned, which is why a page body can contain prose safely.
 */
export function render(template, data, { file = 'template' } = {}) {
  return template.replace(TOKEN_PATTERN, (match, rawKey, escapedKey) => {
    const key = rawKey ?? escapedKey;
    if (!Object.prototype.hasOwnProperty.call(data, key)) {
      throw new Error(`${file}: token {{${key}}} has no value in the provided data`);
    }
    const value = data[key];
    const text = value === null || value === undefined ? '' : String(value);
    return rawKey ? text : escapeHtml(text);
  });
}

export function readTemplate(filename) {
  const file = resolve(srcDir, 'templates', filename);
  try {
    return readFileSync(file, 'utf8');
  } catch {
    throw new Error(`Missing page template: ${file}`);
  }
}

/**
 * A prose fragment from a locale's own directory, when that locale is not the default one.
 *
 * Only *copy* resolves per locale — the homepage and the standalone pages, whose bodies are written
 * prose. A tool panel is the same markup in every language and takes its words from
 * content/ui.json, so it is deliberately not resolved here: one fragment, one structure, N languages.
 *
 * A missing fragment for a published page throws, naming the locale: falling back to the English
 * body would put English prose under an Arabic URL, which is the failure mode the whole locale layer
 * is built to prevent.
 */
export function readLocaleTemplate(filename, locale, defaultLocale) {
  if (!locale || locale === defaultLocale) return readTemplate(filename);
  try {
    return readTemplate(`${locale}/${filename}`);
  } catch {
    throw new Error(
      `Missing "${locale}" template: src/templates/${locale}/${filename}. A page published in "${locale}" needs its own copy — falling back to the default locale's text would ship a half-translated page.`,
    );
  }
}

/**
 * `{name}` substitution for catalogued strings that carry a value — "Saved {name} ({size}).".
 *
 * A missing variable throws rather than rendering a literal `{size}` on a page, because a
 * placeholder that survives into HTML is exactly the kind of thing nobody notices until a visitor
 * does.
 */
export function interpolate(template, vars = {}) {
  return String(template).replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      throw new Error(`String template "${template}" needs a value for {${name}}, and none was provided.`);
    }
    return String(vars[name]);
  });
}

/** Banner placed at the top of every generated file. */
export function generatedBanner({ by, from }) {
  return `<!-- GENERATED FILE — do not edit by hand. Rebuilt by ${by} from ${from}. Run "npm run gen" instead. -->`;
}

/**
 * Writes only when the content actually changed, so git stays quiet on repeat runs.
 */
export function writeGenerated(file, contents) {
  mkdirSync(dirname(file), { recursive: true });
  let existing = null;
  try {
    existing = readFileSync(file, 'utf8');
  } catch {
    existing = null;
  }
  if (existing === contents) return { file, changed: false };
  writeFileSync(file, contents, 'utf8');
  return { file, changed: true };
}

/**
 * Binary twin of writeGenerated: a PNG has to be compared as bytes, not as a string. Keeping the
 * skip-when-unchanged behaviour here too is what stops a run from rewriting 25 identical images.
 */
export function writeGeneratedBinary(file, contents) {
  mkdirSync(dirname(file), { recursive: true });
  let existing = null;
  try {
    existing = readFileSync(file);
  } catch {
    existing = null;
  }
  if (existing !== null && Buffer.compare(existing, contents) === 0) return { file, changed: false };
  writeFileSync(file, contents);
  return { file, changed: true };
}

/** Prints a deterministic summary of what a generator touched. */
export function reportWrites(results, { prefix }) {
  const written = results.filter((result) => result.changed);
  const unchanged = results.length - written.length;
  const label = prefix ? `${prefix}: ` : '';
  if (written.length === 0) {
    console.log(`${label}up to date (${unchanged} file${unchanged === 1 ? '' : 's'} unchanged)`);
    return;
  }
  console.log(`${label}wrote ${written.length} file${written.length === 1 ? '' : 's'}, ${unchanged} unchanged`);
  for (const result of written) {
    console.log(`  + ${result.file.replace(/\\/g, '/')}`);
  }
}

/** Finds every placeholder in rendered HTML. Pure, so tests can feed it strings. */
export function findPlaceholders(html) {
  const found = [];
  for (const { kind, pattern } of PLACEHOLDER_PATTERNS) {
    for (const match of String(html ?? '').matchAll(pattern)) {
      const text = match[0];
      if (!found.some((entry) => entry.text === text && entry.kind === kind)) {
        found.push({ kind, text });
      }
    }
  }
  return found;
}

/**
 * Reports placeholders loudly rather than letting them ship. Returns how many files were
 * flagged, so a caller could turn this into a failure once the content is meant to be final.
 */
export function reportPlaceholders(audits, { prefix = 'content-audit' } = {}) {
  const groups = new Map();
  for (const audit of audits ?? []) {
    for (const entry of audit.placeholders) {
      const key = `${entry.text} (${entry.kind})`;
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(audit.file.replace(/\\/g, '/'));
    }
  }
  if (groups.size === 0) return 0;

  // Grouped by value rather than by page: the canonical origin shows up on every page, and a
  // list of ten identical findings buries the two that actually differ.
  console.log(`${prefix}: ${groups.size} placeholder value(s) still in use:`);
  for (const [key, files] of groups) {
    const list = [...files];
    const shown = list.length <= 3 ? list.join(', ') : `${list.length} pages (${list.slice(0, 3).join(', ')}, …)`;
    console.log(`  ! ${key} — ${shown}`);
  }
  console.log(`${prefix}: fill these in before launch.`);
  return groups.size;
}
