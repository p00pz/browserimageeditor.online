/**
 * Content layer: the single place that reads and validates the JSON files in content/.
 *
 * Rules enforced here:
 *  - content/tools.json is the only source of tool metadata.
 *  - content/targets.json is the only source of long-tail landing pages.
 *  - content/pages.json is the only source of standalone pages (about, privacy, ...).
 *  - content/site.json is the only source of the canonical origin + default meta copy.
 *
 * Every consumer (build-pages, build-targets, gen-sitemap, gen-og) goes through this module so
 * that a bad edit fails loudly, in one message, before anything is written.
 *
 * The validators are pure functions over already-parsed data, and the `load*` functions are
 * thin readers on top of them. That split is what lets tests/content.test.js check the
 * failure modes (duplicate ids, missing fields, unknown related ids) without writing files.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Option lists come from the modules the browser code itself uses, never from a copy kept here:
// a target's `defaultOption` names an id that a real control has to accept, so the validator has
// to know exactly the ids the pages know. Both modules are pure — data and arithmetic, no DOM.
import { MARGINS, PAGE_SIZES, QUALITIES } from '../../src/assets/js/core/engine-pdf.js';
import { CROP_RATIOS, RESIZE_PRESETS } from '../../src/assets/js/core/presets.js';

export const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
export const contentDir = resolve(projectRoot, 'content');
export const srcDir = resolve(projectRoot, 'src');
export const publicDir = resolve(projectRoot, 'public');

export const TOOL_STATUSES = ['live', 'planned'];
/**
 * `utility` is a page that ships and works but must not be advertised: the offline fallback is the
 * only one today. It is generated like any other page, kept out of public/sitemap.xml by the
 * existing non-live filter, and carries `noindex` — the same treatment a planned page gets — while
 * still being allowed to have real, finished copy.
 */
export const PAGE_STATUSES = ['live', 'planned', 'utility'];

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class ContentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContentError';
  }
}

function fail(where, message) {
  throw new ContentError(`${where}: ${message}`);
}

function readJsonFile(where, filename) {
  const file = resolve(contentDir, filename);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    fail(where, `cannot read ${file}. Did you delete a content file?`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(where, `is not valid JSON (${error.message})`);
  }
}

function requireObject(value, where) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(where, 'must be a JSON object');
  }
  return value;
}

function requireArray(value, where) {
  if (!Array.isArray(value)) fail(where, 'must be a JSON array');
  return value;
}

function requireString(data, key, where) {
  const value = data[key];
  if (typeof value !== 'string' || value.trim() === '') {
    fail(where, `"${key}" is required and must be a non-empty string`);
  }
  return value.trim();
}

function requireOptionalString(data, key, where) {
  const value = data[key];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') fail(where, `"${key}" must be a string when present`);
  return value.trim();
}

function requireKebabCase(data, key, where) {
  const value = requireString(data, key, where);
  if (!KEBAB_CASE.test(value)) {
    fail(where, `"${key}" must be lowercase kebab-case, received "${value}"`);
  }
  return value;
}

function requireStatus(data, where, allowed) {
  const status = requireString(data, 'status', where);
  if (!allowed.includes(status)) {
    fail(where, `"status" must be one of ${allowed.join(' | ')}, received "${status}"`);
  }
  return status;
}

function requireStringArray(data, key, where) {
  const value = data[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail(where, `"${key}" is required and must be an array of strings`);
  }
  return value.map((item) => item.trim());
}

function requireHexColor(data, key, where) {
  const value = requireString(data, key, where);
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    fail(where, `"${key}" must be a six-digit hex colour such as "#0366d6", received "${value}"`);
  }
  return value;
}

function requirePositiveInteger(data, key, where) {
  const value = data[key];
  if (!Number.isInteger(value) || value <= 0) {
    fail(where, `"${key}" is required and must be a positive integer`);
  }
  return value;
}

function readFaq(data, where) {
  if (data.faq === undefined) return [];
  return requireArray(data.faq, `${where}.faq`).map((item, index) => {
    const at = `${where}.faq[${index}]`;
    const question = requireObject(item, at);
    return { q: requireString(question, 'q', at), a: requireString(question, 'a', at) };
  });
}

function assertUnique(entries, key, where, noun) {
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry[key])) {
      fail(where, `duplicate ${noun} "${entry[key]}" — each one becomes a page, so they must be unique`);
    }
    seen.add(entry[key]);
  }
}

/**
 * Site-wide metadata. The url is normalised without a trailing slash so callers can
 * concatenate paths without worrying about double slashes.
 *
 * `tagline` completes the homepage <title> as "<name> — <tagline>", so the brand line is not
 * typed into a hand-written <title> that can disagree with the rest of the site.
 *
 * `contactEmail` and `contactRepo` live here rather than in the contact page body so the
 * address is typed in exactly one place; both may be left as placeholders, which the build
 * reports loudly instead of publishing silently.
 */
export function validateSite(data, where = 'content/site.json') {
  const site = requireObject(data, where);
  const url = requireString(site, 'url', where).replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/.test(url)) {
    fail(where, `"url" must be an absolute http(s) origin, received "${url}"`);
  }
  const ogImage = requireString(site, 'ogImage', where);
  if (!ogImage.startsWith('/')) {
    fail(where, `"ogImage" must be a root-relative path such as "/og/home.png"`);
  }

  // Install metadata lives here rather than in public/manifest.webmanifest, so the name and colours
  // the installed app uses cannot drift from the site's own metadata. The colours are literal hex
  // because a web app manifest has no access to the CSS custom properties in base.css.
  const shortName = requireString(site, 'shortName', where);
  if (shortName.length > 12) {
    fail(
      where,
      `"shortName" must be 12 characters or fewer or Chrome truncates it on a home screen (received ${shortName.length}: "${shortName}")`,
    );
  }
  const themeColor = requireHexColor(site, 'themeColor', where);
  const themeColorDark = requireHexColor(site, 'themeColorDark', where);
  const backgroundColor = requireHexColor(site, 'backgroundColor', where);

  // Locales drive every URL the site emits. The default locale is prefixless, so declaring a
  // second language later adds prefixed URLs without moving any existing one.
  const locales = requireArray(site.locales, `${where}.locales`).map((entry, index) => {
    const at = `${where}.locales[${index}]`;
    const locale = requireObject(entry, at);
    const code = requireString(locale, 'code', at);
    if (!/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(code)) {
      fail(at, `"code" must be a language tag such as "en" or "pt-BR", received "${code}"`);
    }
    const dir = locale.dir === undefined ? 'ltr' : requireString(locale, 'dir', at);
    if (dir !== 'ltr' && dir !== 'rtl') {
      fail(at, `"dir" must be "ltr" or "rtl", received "${dir}"`);
    }
    return { code, label: requireString(locale, 'label', at), dir };
  });
  if (locales.length === 0) fail(where, '"locales" must list at least one language');
  assertUnique(locales, 'code', `${where}.locales`, 'locale code');

  const defaultLocale = requireString(site, 'defaultLocale', where);
  if (!locales.some((locale) => locale.code === defaultLocale)) {
    fail(where, `"defaultLocale" ("${defaultLocale}") must be one of the codes in "locales"`);
  }

  if (site.ads !== undefined && typeof site.ads !== 'boolean') {
    fail(where, '"ads" must be true or false when present');
  }
  const contactRepo = requireOptionalString(site, 'contactRepo', where);
  if (contactRepo !== null && !/^https?:\/\//.test(contactRepo)) {
    fail(where, `"contactRepo" must be an absolute http(s) URL, received "${contactRepo}"`);
  }
  return {
    name: requireString(site, 'name', where),
    tagline: requireString(site, 'tagline', where),
    url,
    description: requireString(site, 'description', where),
    shortName,
    themeColor,
    themeColorDark,
    backgroundColor,
    ogImage,
    contactEmail: requireString(site, 'contactEmail', where),
    contactRepo,
    defaultLocale,
    locales,
    ads: site.ads === true,
  };
}

/* ---------- locale-aware loading ---------- */

/**
 * Which fields a translation file is allowed to override, and which field identifies an entry.
 *
 * Only text is translatable. Ids, slugs, mime types, statuses, byte limits and relations stay in
 * the default file, so a translation can never move a URL, change a tool's accepted formats or
 * point a page at a different parent tool by accident.
 */
const TRANSLATABLE = {
  /**
   * The UI string catalogue: one flat map of `ui.*` (rendered into markup at build time) and
   * `js.*` (injected into the page for the runtime) keys.
   *
   * The prefix decides delivery, not the file: a `ui.` key becomes a `{{t.…}}` token in a template,
   * a `js.` key goes into the page's strings block. Both live here so a phrase is written once, and
   * the split is checked in both directions by tests/i18n.test.js.
   */
  'ui.json': { key: 'keys', fields: [] },
  'tools.json': {
    key: 'id',
    // `name` is translatable because it is what a card, a breadcrumb and the SoftwareApplication
    // markup call the tool. Left in English, an Arabic homepage would list three tools whose names
    // are English while everything around them is Arabic. `slug` is not: that is the URL.
    fields: ['name', 'title', 'description', 'h1', 'intro', 'navLabel', 'keywords', 'targetKeyword', 'faq'],
  },
  'pages.json': { key: 'id', fields: ['title', 'description', 'h1', 'navLabel'] },
  'targets.json': {
    key: 'slug',
    fields: [
      'title',
      'description',
      'h1',
      'intro',
      'navLabel',
      'targetKeyword',
      'keywords',
      'faq',
      'uniqueContent',
    ],
  },
  'site.json': { key: null, fields: ['name', 'tagline', 'description'] },
};

/** Reads a locale override file; a missing file is normal, malformed JSON is not. */
function readLocaleFile(filename, locale) {
  let raw;
  try {
    raw = readFileSync(resolve(contentDir, locale, filename), 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`content/${locale}/${filename}`, `is not valid JSON (${error.message})`);
  }
}

/**
 * Overlays a translated content file on the default one.
 *
 * **A present translation file is a publish list.** Only the entries it translates become pages in
 * that locale; everything else stays default-locale-only. The earlier behaviour — merge and publish
 * the untranslated entries in English — cannot coexist with a translated URL: the audit rejects two
 * pages that share a `<title>`, so an English fallback under `/ar/` would fail the build anyway. A
 * missing file is still a full fallback with a warning, which is what keeps a half-set-up locale
 * visible rather than silently empty.
 *
 * An entry that does not exist in the default file is an error, not a fallback: that is a typo, and
 * it would otherwise vanish.
 */
function mergeTranslation(base, override, filename, locale) {
  const { key, fields } = TRANSLATABLE[filename];
  const where = `content/${locale}/${filename}`;
  const allowed = new Set(fields);

  if (key === null) {
    const data = requireObject(override, where);
    const merged = { ...base };
    for (const [field, value] of Object.entries(data)) {
      if (!allowed.has(field)) {
        fail(where, `"${field}" cannot be translated. Translatable fields are: ${fields.join(', ')}`);
      }
      merged[field] = value;
    }
    return merged;
  }

  if (key === 'keys') {
    return mergeStrings(base, override, filename, locale);
  }

  const byId = new Map(base.map((entry) => [entry[key], entry]));
  const overrides = new Map();
  requireArray(override, where).forEach((raw, index) => {
    const at = `${where}[${index}]`;
    const entry = requireObject(raw, at);
    const identity = requireString(entry, key, at);
    const source = byId.get(identity);
    if (!source) {
      fail(
        at,
        `"${key}" ("${identity}") is not in the default locale's ${filename} — a translation file lists translations, it cannot invent entries`,
      );
    }
    for (const field of Object.keys(entry)) {
      if (field !== key && !allowed.has(field)) {
        fail(at, `"${field}" cannot be translated. Translatable fields are: ${fields.join(', ')}`);
      }
    }
    requireCompleteTranslation(entry, source, { key, fields, identity, where, at, locale, filename });
    overrides.set(identity, entry);
  });

  const published = base
    .filter((entry) => overrides.has(entry[key]))
    .map((entry) => ({ ...entry, ...overrides.get(entry[key]) }));

  const heldBack = base.filter((entry) => !overrides.has(entry[key]));
  if (heldBack.length > 0) {
    console.log(
      `content: "${locale}" publishes ${published.length} of ${base.length} ${filename} entr${base.length === 1 ? 'y' : 'ies'}; staying default-locale-only: ${heldBack.map((entry) => entry[key]).join(', ')}`,
    );
  }
  return published;
}

/**
 * A string catalogue is flat, so every key is translatable and the only rules are the two that
 * matter: a translation may not invent a key, and an untranslated key is reported by name.
 *
 * The reporting is deliberately loud. A missing `ui.` key shows the English sentence on an Arabic
 * page, which is exactly the half-translated state this project refuses to discover in production.
 */
function mergeStrings(base, override, filename, locale) {
  const where = `content/${locale}/${filename}`;
  const data = requireObject(override, where);
  const merged = { ...base };
  const unknown = [];

  for (const [name, value] of Object.entries(data)) {
    if (!Object.prototype.hasOwnProperty.call(base, name)) {
      unknown.push(name);
      continue;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      fail(where, `"${name}" must be a non-empty string`);
    }
    merged[name] = value.trim();
  }

  if (unknown.length > 0) {
    fail(
      where,
      `${unknown.length} key(s) are not in ${filename}: ${unknown.slice(0, 6).join(', ')}${unknown.length > 6 ? ', …' : ''} — a translation file lists translations, it cannot invent strings`,
    );
  }

  const missing = Object.keys(base).filter((name) => !Object.prototype.hasOwnProperty.call(data, name));
  if (missing.length > 0) {
    console.warn(
      `content: ${missing.length} of ${Object.keys(base).length} ${filename} string(s) have no "${locale}" translation and will render in the default locale: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', …' : ''}`,
    );
  }
  return merged;
}

/**
 * The gate that makes a translated URL mean something.
 *
 * A published entry must translate every field its default-locale original actually uses. Without
 * this, "publish three tools in Arabic" quietly becomes "publish three tools, two thirds in
 * English", and the two pages then share a `<title>` — which the SEO audit already rejects.
 *
 * FAQ answers must stay in step in count as well as in language, so both pages answer the same
 * questions in the same order and the FAQPage markup describes the same thing in each locale.
 */
/**
 * The translatable fields an entry has left in the default locale.
 *
 * Exported so the rule can be tested directly rather than through a temporary file: it is the rule,
 * not the file loading, that decides whether a page is half English.
 */
export function untranslatedFields(entry, source, fields) {
  return fields.filter((field) => {
    const original = source[field];
    if (original === undefined || original === null) return false;
    if (Array.isArray(original) && original.length === 0) return false;
    const translated = entry[field];
    return (
      translated === undefined ||
      translated === null ||
      (typeof translated === 'string' && translated.trim() === '')
    );
  });
}

function requireCompleteTranslation(entry, source, { fields, identity, at, locale, filename }) {
  for (const field of untranslatedFields(entry, source, fields)) {
    fail(
      at,
      `"${identity}" is published in "${locale}" but has no "${field}" translation. Add it to content/${locale}/${filename}, or remove the entry and let it stay default-locale-only — a published entry is all-or-nothing.`,
    );
  }

  if (Array.isArray(source.faq) && source.faq.length > 0) {
    const translated = Array.isArray(entry.faq) ? entry.faq : [];
    if (translated.length !== source.faq.length) {
      fail(
        at,
        `"${identity}" translates ${translated.length} FAQ item(s) but the default locale has ${source.faq.length}. A translation answers the same questions, in the same order.`,
      );
    }
  }
}

/** The default file, with `content/<locale>/<file>` overlaid when that file exists. */
function readLocalizedJson(filename, locale, defaultLocale) {
  const base = readJsonFile(`content/${filename}`, filename);
  if (!locale || locale === defaultLocale) return base;
  const override = readLocaleFile(filename, locale);
  if (override === null) {
    console.warn(
      `content: content/${locale}/${filename} does not exist, so those pages fall back to the default locale's copy.`,
    );
    return base;
  }
  return mergeTranslation(base, override, filename, locale);
}

/** The default locale, needed by every loader before it knows which file to read. */
function defaultLocaleOf() {
  return requireString(requireObject(readJsonFile('content/site.json', 'site.json'), 'content/site.json'), 'defaultLocale', 'content/site.json');
}

export function loadSite(locale = null) {
  const base = readJsonFile('content/site.json', 'site.json');
  if (!locale || locale === validateSite(base).defaultLocale) return validateSite(base);
  return validateSite(readLocalizedJson('site.json', locale, validateSite(base).defaultLocale));
}

/**
 * Tool metadata, validated and cross-referenced.
 *
 * `id` is the stable handle that never changes; `slug` is the URL and may change (it has
 * already: compress -> compress-image). Cross-tool references use ids for that reason.
 */
/**
 * Licences a model or a model's weights may carry.
 *
 * Enforced here rather than left to review, because the red lines in this project are legal rather
 * than technical: AGPL-3.0 is copyleft on an ad-monetised site, and "non-commercial research" weights
 * cannot be used by a site that runs ads at all. A licence that is not on this list fails the build
 * with the licence's own name in the message, so adding a model cannot quietly skip the question.
 *
 * The full text of each one is quoted in LICENSES-THIRD-PARTY.md, and tests/models.test.js checks
 * that every entry here appears there.
 */
export const ALLOWED_MODEL_LICENSES = ['Apache-2.0', 'MIT'];

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The `models` key: what a tool downloads at runtime, and under what terms.
 *
 * `sha256` is the host's own object id for the file (Hugging Face publishes it for LFS files), and
 * `bytes` is the exact size. Both are recorded so a model that is replaced upstream is a visible
 * change in a diff rather than a silent substitution, and so `model-store.js` can refuse a
 * truncated download.
 */
function readModels(data, at) {
  const raw = data.models;
  if (raw === undefined || raw === null) return [];
  const list = requireArray(raw, `${at}.models`);

  const models = list.map((entry, index) => {
    const where = `${at}.models[${index}]`;
    const model = requireObject(entry, where);

    const license = requireString(model, 'license', where);
    if (!ALLOWED_MODEL_LICENSES.includes(license)) {
      fail(
        where,
        `model licence "${license}" is not allowed. Allowed: ${ALLOWED_MODEL_LICENSES.join(', ')}. ` +
          'AGPL and non-commercial weights are a red line for this project — see LICENSES-THIRD-PARTY.md.',
      );
    }

    const url = requireString(model, 'url', where);
    if (!url.startsWith('https://')) fail(where, '"url" must be an https URL');
    const licenseUrl = requireString(model, 'licenseUrl', where);
    if (!licenseUrl.startsWith('https://')) fail(where, '"licenseUrl" must be an https URL');
    const sourceUrl = requireString(model, 'sourceUrl', where);
    if (!sourceUrl.startsWith('https://')) fail(where, '"sourceUrl" must be an https URL');

    const sha256 = requireString(model, 'sha256', where).toLowerCase();
    if (!SHA256.test(sha256)) fail(where, '"sha256" must be 64 hexadecimal characters');

    return {
      id: requireKebabCase(model, 'id', where),
      name: requireString(model, 'name', where),
      purpose: requireString(model, 'purpose', where),
      url,
      bytes: requirePositiveInteger(model, 'bytes', where),
      license,
      licenseUrl,
      sourceUrl,
      sha256,
    };
  });

  assertUnique(models, 'id', `${at}.models`, 'id');
  return models;
}

export function validateTools(raw, where = 'content/tools.json', { knownIds = null } = {}) {
  const entries = requireArray(raw, where);
  if (entries.length === 0) fail(where, 'must contain at least one tool');

  const tools = entries.map((entry, index) => {
    const at = `${where}[${index}]`;
    const data = requireObject(entry, at);

    const outputs = requireStringArray(data, 'outputs', at);
    if (outputs.length === 0) fail(at, '"outputs" must list at least one mime type');
    const defaultOutput = requireString(data, 'defaultOutput', at);
    if (!outputs.includes(defaultOutput)) {
      fail(at, `"defaultOutput" ("${defaultOutput}") must be one of "outputs"`);
    }

    return {
      id: requireKebabCase(data, 'id', at),
      slug: requireKebabCase(data, 'slug', at),
      name: requireString(data, 'name', at),
      navLabel: requireString(data, 'navLabel', at),
      status: requireStatus(data, at, TOOL_STATUSES),
      category: requireString(data, 'category', at),
      title: requireString(data, 'title', at),
      description: requireString(data, 'description', at),
      h1: requireString(data, 'h1', at),
      intro: requireString(data, 'intro', at),
      keywords: requireStringArray(data, 'keywords', at),
      targetKeyword: requireString(data, 'targetKeyword', at),
      accepts: requireStringArray(data, 'accepts', at),
      outputs,
      defaultOutput,
      maxInputBytes: requirePositiveInteger(data, 'maxInputBytes', at),
      related: requireStringArray(data, 'related', at),
      ogImage: requireOptionalString(data, 'ogImage', at),
      models: readModels(data, at),
      faq: readFaq(data, at),
    };
  });

  assertUnique(tools, 'id', where, 'id');
  assertUnique(tools, 'slug', where, 'slug');

  // Cross-references are checked against the **default locale's** tool list, not this file's.
  // A locale publishes a subset — Arabic covers three tools and the homepage — while `related`
  // still names tools that simply have not been translated yet. Checking the subset would make
  // every translated tool that relates to an untranslated one a build failure.
  const ids = knownIds ?? new Set(tools.map((tool) => tool.id));
  for (const tool of tools) {
    for (const relatedId of tool.related) {
      if (!ids.has(relatedId)) {
        fail(where, `tool "${tool.id}" lists an unknown related tool id "${relatedId}"`);
      }
      if (relatedId === tool.id) {
        fail(where, `tool "${tool.id}" lists itself in "related"`);
      }
    }
  }

  return tools;
}

export function loadTools(locale = null) {
  const defaultLocale = defaultLocaleOf();
  if (!locale || locale === defaultLocale) {
    return validateTools(readLocalizedJson('tools.json', null, defaultLocale));
  }
  const knownIds = new Set(loadTools(null).map((tool) => tool.id));
  return validateTools(readLocalizedJson('tools.json', locale, defaultLocale), `content/${locale}/tools.json`, {
    knownIds,
  });
}

/**
 * Standalone pages (about, contact, privacy, terms, how-it-works).
 *
 * This file exists so the sitemap can be built from the content model rather than from
 * whatever happens to be on disk, which is the rule the other generators already follow. The
 * page bodies themselves are hand-written fragments under src/templates/pages/.
 */
export function validatePages(raw, where = 'content/pages.json') {
  const entries = requireArray(raw, where);

  const pages = entries.map((entry, index) => {
    const at = `${where}[${index}]`;
    const data = requireObject(entry, at);

    const priority = data.priority === undefined ? 0.5 : Number(data.priority);
    if (!Number.isFinite(priority) || priority < 0 || priority > 1) {
      fail(at, '"priority" must be a number between 0 and 1 when present');
    }

    const lastUpdated = requireString(data, 'lastUpdated', at);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(lastUpdated)) {
      fail(at, `"lastUpdated" must be an ISO date (YYYY-MM-DD), received "${lastUpdated}"`);
    }

    // Where this page is linked from. The footer lists every live page; the header is for the
    // one or two that belong in the primary navigation.
    const nav = data.nav === undefined ? ['footer'] : requireStringArray(data, 'nav', at);
    for (const place of nav) {
      if (place !== 'header' && place !== 'footer') {
        fail(at, `"nav" entries must be "header" or "footer", received "${place}"`);
      }
    }

    return {
      id: requireKebabCase(data, 'id', at),
      slug: requireKebabCase(data, 'slug', at),
      navLabel: requireString(data, 'navLabel', at),
      status: requireStatus(data, at, PAGE_STATUSES),
      title: requireString(data, 'title', at),
      description: requireString(data, 'description', at),
      h1: requireString(data, 'h1', at),
      lastUpdated,
      priority,
      nav,
    };
  });

  assertUnique(pages, 'id', where, 'id');
  assertUnique(pages, 'slug', where, 'slug');

  return pages;
}

export function loadPages(locale = null) {
  return validatePages(readLocalizedJson('pages.json', locale, defaultLocaleOf()));
}

/**
 * The UI string catalogue: every phrase the interface says, in one flat map.
 *
 * Two prefixes, two consumers. `ui.` keys are read at build time and rendered into markup (a
 * template writes `{{t.ui.dropzone.title}}`); `js.` keys are injected into the page as a JSON block
 * and read at runtime by src/assets/js/ui/strings.js, which strips the prefix so a call site reads
 * `t('compress.ready')`.
 *
 * Keeping both in one file is deliberate: the alternative is a phrase being written once in a
 * fragment and again in a script, which is precisely the duplication this project generates its way
 * out of everywhere else.
 */
export function validateUi(raw, where = 'content/ui.json') {
  const data = requireObject(raw, where);
  const names = Object.keys(data);
  if (names.length === 0) fail(where, 'must contain at least one string');

  for (const name of names) {
    // Hyphens are allowed in a segment because catalogue keys mirror ids: `js.preset.instagram-square`
    // is keyed by the preset's own id, so a preset cannot be added without a place to translate it.
    if (!/^(ui|js)\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(name)) {
      fail(
        where,
        `"${name}" is not a valid string key. Keys are \"ui.\" for markup or \"js.\" for the runtime, then dotted lowercase words, e.g. "ui.dropzone.title" or "js.error.OUT_OF_MEMORY".`,
      );
    }
    if (typeof data[name] !== 'string' || data[name].trim() === '') {
      fail(where, `"${name}" must be a non-empty string`);
    }
  }

  return Object.fromEntries(names.map((name) => [name, data[name].trim()]));
}

export function loadUi(locale = null) {
  return validateUi(readLocalizedJson('ui.json', locale, defaultLocaleOf()));
}

/**
 * The subset a page injects: the `js.` half of the catalogue, keys unchanged.
 *
 * **Keys intentionally keep their `js.` prefix.** The block is keyed by the catalogue's own names, so
 * the key a script writes is the key the catalogue defines — `t('js.common.waiting')` finds
 * `js.common.waiting`. An earlier version stripped the prefix on the way in, which meant every one of
 * the 164 call sites (all prefixed, none bare) looked up a key that was not there, and the runtime
 * fell back to printing the key name: the whole interface rendered as `js.common.download`.
 *
 * A lossy transformation with no consumer is not an optimisation; it is a way for two halves of the
 * system to disagree about what a key is called.
 */
export function runtimeStrings(catalog) {
  return Object.fromEntries(Object.entries(catalog).filter(([name]) => name.startsWith('js.')));
}

/** The subset the template engine reads: `ui.foo` becomes the token `{{t.ui.foo}}`. */
export function markupStrings(catalog) {
  return Object.fromEntries(
    Object.entries(catalog)
      .filter(([name]) => name.startsWith('ui.'))
      .map(([name, value]) => [`t.${name}`, value]),
  );
}

/**
 * Long-tail landing pages. Each target belongs to exactly one tool, because the generated page
 * links back to that tool as its call to action.
 *
 * That reference is `parentToolId` — a tool **id**, not a slug. Ids are stable; slugs are URLs and
 * have already changed once (compress -> compress-image). `related` on a tool points at ids for
 * the same reason, so there is exactly one convention for "this points at that tool" across the
 * whole content layer, and it survives a URL change.
 */
/* ---------- target page content ---------- */

/**
 * A target page exists to answer one narrow, high-intent query better than the parent tool page
 * can, so the prose on it has to be about that exact use case rather than the tool's intro with a
 * number swapped in. That is a measurable property, so the build measures it — and refuses to
 * publish a target that does not clear the bar.
 */
export const MIN_UNIQUE_WORDS = 250;

/** Authoring marker for a claim that still needs a human to check it. Never allowed on a live page. */
export const VERIFY_MARKER = '[VERIFY]';

/**
 * Which options a target may pre-set, per parent tool, and how each value is checked.
 *
 * A typo'd key would produce a page that claims to be pre-configured and quietly is not, which is
 * worse than a build failure, so an unknown key is an error rather than a warning.
 */
const TARGET_DEFAULT_OPTIONS = {
  compress: { targetSizeKB: 'pixels' },
  resize: { presetId: 'resizePreset', width: 'pixels', height: 'pixels' },
  convert: { outputMime: 'toolOutput' },
  crop: { ratioId: 'cropRatio' },
  'image-to-pdf': { pageSizeId: 'pageSize', marginId: 'margin', qualityId: 'quality' },
};

const OPTION_CHECKS = {
  resizePreset: { kind: 'an id from RESIZE_PRESETS', ids: RESIZE_PRESETS },
  cropRatio: { kind: 'an id from CROP_RATIOS', ids: CROP_RATIOS },
  pageSize: { kind: 'an id from PAGE_SIZES', ids: PAGE_SIZES },
  margin: { kind: 'an id from MARGINS', ids: MARGINS },
  quality: { kind: 'an id from QUALITIES', ids: QUALITIES },
};

/** Word count for the content gate. Headings and bullet markers are syntax, so they are not words. */
export function countWords(text) {
  return text
    .split('\n')
    .map((line) => line.trim().replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+/, ''))
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

/**
 * Destructive-free parse of uniqueContent into renderable blocks. The supported markup is tiny on
 * purpose — blank-line paragraphs, "## " headings, "- " lists, no inline HTML — so nothing written
 * into content/ can inject markup into a page.
 *
 * A block that mixes those forms comes back with a `broken` reason, which the validator turns into
 * a build error: a half-rendered list is exactly the kind of thing that ships unseen.
 */
export function parseUniqueContent(text) {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .map((block) => {
      const lines = block
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      const [first] = lines;

      if (first.startsWith('## ')) {
        return lines.length > 1
          ? { type: 'h2', text: first.slice(3), broken: 'a "## " heading must be its own paragraph' }
          : { type: 'h2', text: first.slice(3) };
      }

      if (first.startsWith('- ')) {
        return lines.some((line) => !line.startsWith('- '))
          ? { type: 'ul', items: [], broken: 'every line of a "- " list must start with "- "' }
          : { type: 'ul', items: lines.map((line) => line.slice(2).trim()) };
      }

      return lines.some((line) => line.startsWith('- ') || line.startsWith('## '))
        ? { type: 'p', text: first, broken: 'a "## " heading or "- " list has to start its own paragraph' }
        : { type: 'p', text: lines.join(' ') };
    });
}

function requireUniqueContent(data, at, status) {
  const uniqueContent = requireString(data, 'uniqueContent', at);
  const words = countWords(uniqueContent);
  if (words < MIN_UNIQUE_WORDS) {
    fail(
      at,
      `"uniqueContent" is ${words} words — a target page needs at least ${MIN_UNIQUE_WORDS} words of content that appears nowhere else. Write about this exact use case, or drop the entry.`,
    );
  }
  if (status === 'live' && uniqueContent.includes(VERIFY_MARKER)) {
    fail(
      at,
      `"uniqueContent" still contains ${VERIFY_MARKER} and this entry is live. A published page must not carry an unverified claim: confirm the fact and remove the marker, or keep the entry "planned" until it is checked.`,
    );
  }
  const blocks = parseUniqueContent(uniqueContent);
  const broken = blocks.find((block) => block.broken);
  if (broken) fail(at, `"uniqueContent" is malformed: ${broken.broken}`);
  return { uniqueContent, uniqueContentWords: words, uniqueContentBlocks: blocks };
}

function requireDefaultOption(data, tool, at) {
  const allowed = TARGET_DEFAULT_OPTIONS[tool.id] ?? {};
  const raw = requireObject(data.defaultOption, `${at}.defaultOption`);
  const keys = Object.keys(raw);
  if (keys.length === 0) {
    fail(`${at}.defaultOption`, 'must set at least one option — that is what makes this a target page rather than a second copy of the tool page');
  }

  for (const key of keys) {
    const check = allowed[key];
    if (!check) {
      const known = Object.keys(allowed);
      fail(
        `${at}.defaultOption`,
        known.length === 0
          ? `"${key}" is not an option of tool "${tool.id}", which takes no pre-set options`
          : `"${key}" is not an option of tool "${tool.id}". Pre-settable options are: ${known.join(', ')}`,
      );
    }

    const value = raw[key];
    if (check === 'pixels') {
      if (!Number.isInteger(value) || value <= 0) {
        fail(`${at}.defaultOption`, `"${key}" must be a positive integer, received ${JSON.stringify(value)}`);
      }
      continue;
    }

    if (check === 'toolOutput') {
      if (typeof value !== 'string' || !tool.outputs.includes(value)) {
        fail(
          `${at}.defaultOption`,
          `"${key}" must be one of the tool's own outputs (${tool.outputs.join(', ')}), received ${JSON.stringify(value)}`,
        );
      }
      continue;
    }

    const { ids, kind } = OPTION_CHECKS[check];
    if (typeof value !== 'string' || !ids.some((entry) => entry.id === value)) {
      fail(
        `${at}.defaultOption`,
        `"${key}" must be ${kind}: ${ids.map((entry) => entry.id).join(', ')}. Received ${JSON.stringify(value)}`,
      );
    }
  }

  // The two ways of saying "this size" must not both be present, or the page could disagree with
  // itself about the size it claims to be pre-configured for.
  if (raw.presetId !== undefined && (raw.width !== undefined || raw.height !== undefined)) {
    fail(
      `${at}.defaultOption`,
      'cannot set "presetId" together with "width"/"height" — pick one',
    );
  }

  return raw;
}

/** Every published string field, so the unverified-claim gate covers the whole entry, not one field. */
function publishedFields(target) {
  return [
    ['title', target.title],
    ['description', target.description],
    ['h1', target.h1],
    ['intro', target.intro],
    ['uniqueContent', target.uniqueContent],
    ...target.faq.flatMap((item, index) => [
      [`faq[${index}].q`, item.q],
      [`faq[${index}].a`, item.a],
    ]),
  ];
}

/**
 * Long-tail landing pages. Each target belongs to exactly one tool, because the generated page
 * embeds that tool's own working panel, configured with the target's defaults.
 *
 * The parent reference is `parentToolId` — a tool **id**, not a slug. Ids are stable; slugs are
 * URLs and have already changed once (compress -> compress-image). `related` on a tool points at
 * ids for the same reason, so there is one convention for "this points at that tool" across the
 * whole content layer.
 *
 * `tools` is the validated tool list from validateTools(), not a list of ids: the validator needs
 * each parent's status, outputs and option vocabulary.
 */
export function validateTargets(raw, tools, where = 'content/targets.json', { allTools = null } = {}) {
  const entries = requireArray(raw, where);
  const byId = new Map(requireArray(tools, 'tools').map((tool) => [tool.id, tool]));
  const everyTool = new Map(requireArray(allTools ?? tools, 'tools').map((tool) => [tool.id, tool]));

  const targets = entries.map((entry, index) => {
    const at = `${where}[${index}]`;
    const data = requireObject(entry, at);

    const parentToolId = requireKebabCase(data, 'parentToolId', at);
    const parentTool = byId.get(parentToolId);
    if (!parentTool) {
      // Two different mistakes, two different messages: a typo, or a target published in a locale
      // where its parent tool is not.
      fail(
        at,
        everyTool.has(parentToolId)
          ? `"parentToolId" ("${parentToolId}") exists but is not published in this locale, so this page would have no working tool panel to show. Publish "${parentToolId}" here first, or drop this entry.`
          : `"parentToolId" ("${parentToolId}") is not an id in content/tools.json`,
      );
    }

    const status = requireStatus(data, at, TOOL_STATUSES);
    // Every target page embeds its parent's working panel, so the parent has to exist as a live
    // tool: a planned tool has no panel fragment to render and no script to configure.
    if (parentTool.status !== 'live') {
      fail(
        at,
        `"parentToolId" ("${parentToolId}") is not a live tool, so this page would have no working tool on it. Make "${parentToolId}" live first, or drop this target.`,
      );
    }

    const target = {
      slug: requireKebabCase(data, 'slug', at),
      parentToolId,
      status,
      navLabel: requireString(data, 'navLabel', at),
      title: requireString(data, 'title', at),
      description: requireString(data, 'description', at),
      h1: requireString(data, 'h1', at),
      intro: requireString(data, 'intro', at),
      targetKeyword: requireString(data, 'targetKeyword', at),
      keywords: requireStringArray(data, 'keywords', at),
      defaultOption: requireDefaultOption(data, parentTool, at),
      ...requireUniqueContent(data, at, status),
      faq: readFaq(data, at),
    };

    // A live page must not publish a claim nobody has checked. The marker is allowed while an
    // entry is planned (its page is noindex), so a draft can be parked without losing the note.
    if (status === 'live') {
      for (const [field, value] of publishedFields(target)) {
        if (value.includes(VERIFY_MARKER)) {
          fail(
            at,
            `"${field}" still contains ${VERIFY_MARKER} and this entry is live. Confirm the fact and remove the marker, or keep the entry "planned" until it is checked.`,
          );
        }
      }
    }

    return target;
  });

  assertUnique(targets, 'slug', where, 'slug');
  // Two pages chasing the same query cannibalise each other, which is the opposite of what a
  // long-tail page is for.
  assertUnique(targets, 'targetKeyword', where, 'target keyword');

  return targets;
}

export function loadTargets(tools, locale = null) {
  const defaultLocale = defaultLocaleOf();
  const raw = readLocalizedJson('targets.json', locale, defaultLocale);
  if (!locale || locale === defaultLocale) return validateTargets(raw, tools);
  return validateTargets(raw, tools, `content/${locale}/targets.json`, { allTools: loadTools(null) });
}

/** Path portion of a tool page, e.g. "/tools/compress-image/". */
export function toolPath(tool) {
  return `/tools/${tool.slug}/`;
}

/** Path portion of a target landing page, e.g. "/targets/compress-image-to-100kb/". */
export function targetPath(target) {
  return `/targets/${target.slug}/`;
}

/** Path portion of a standalone page, e.g. "/pages/privacy/". */
export function pagePath(page) {
  return `/pages/${page.slug}/`;
}

/* ---------- locale-aware URLs and output paths ---------- */

/**
 * A route in one locale. The default locale is prefixless, so declaring a second language adds
 * `/ar/...` URLs without moving a single existing one — which is the whole point of deciding this
 * before there is anything to translate.
 */
export function localePath(site, locale, path) {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  if (locale === site.defaultLocale) return suffix;
  return suffix === '/' ? `/${locale}/` : `/${locale}${suffix}`;
}

/** Absolute URL for a route in one locale. */
export function pageUrl(site, locale, path) {
  const suffix = localePath(site, locale, path);
  return suffix === '/' ? `${site.url}/` : `${site.url}${suffix}`;
}

/**
 * Every alternate URL for a route: one per configured locale, plus `x-default`, which is what a
 * crawler uses when no language matches. With one locale configured this is a self-referencing
 * `en` plus `x-default`, which is valid and needs no adjustment when a second language lands.
 */
export function alternateLinks(site, path) {
  return [
    ...site.locales
      .filter((locale) => localePublishes(site, locale.code, path))
      .map((locale) => ({ hreflang: locale.code, href: pageUrl(site, locale.code, path) })),
    { hreflang: 'x-default', href: pageUrl(site, site.defaultLocale, path) },
  ];
}

/**
 * Which paths a locale actually publishes, computed once per process.
 *
 * Cached because `alternateLinks` is called for every route by three different generators, and the
 * answer cannot change while one of them is running: it is derived entirely from content/ on disk.
 */
const publishedPaths = new Map();

function pathsForLocale(code) {
  if (!publishedPaths.has(code)) {
    publishedPaths.set(code, new Set(siteRoutes(code).routes.map((route) => route.path)));
  }
  return publishedPaths.get(code);
}

/**
 * Whether a route exists in a locale, which is what makes hreflang honest.
 *
 * With English as the only locale this is always true and the alternates are self-referencing, as
 * they were. Once a locale publishes a subset — Arabic covers three tools and the homepage, not the
 * other twenty routes — an English-only page must not advertise an Arabic twin that was never
 * generated, and a crawler must not be sent to a 404.
 */
export function localePublishes(site, code, path) {
  void site;
  const clean = path.startsWith('/') ? path : `/${path}`;
  return pathsForLocale(code).has(clean);
}

/** The locale record for a code, so `dir` never has to be guessed at a call site. */
export function localeFor(site, code) {
  return site.locales.find((locale) => locale.code === code) ?? site.locales[0];
}

/**
 * Where a route is written on disk. Non-default locales nest under their own directory, which the
 * Vite entry walker picks up on its own, so a new locale needs no config change either.
 */
export function localeSrcDir(site, locale) {
  return locale === site.defaultLocale ? srcDir : resolve(srcDir, locale);
}

/** Absolute path of the generated file for a route, e.g. "/pages/about/" -> src/pages/about/index.html. */
export function pageFile(site, locale, path) {
  const clean = path.replace(/^\/+|\/+$/g, '');
  return resolve(localeSrcDir(site, locale), clean, 'index.html');
}

/**
 * The include prefix a page uses for its partials. Non-default locales get their own copies under
 * src/partials/<code>/, so a translated nav is possible without changing how includes resolve.
 */
export function partialsPrefix(site, locale) {
  return locale === site.defaultLocale ? '' : `${locale}/`;
}

/* ---------- the route inventory ---------- */

/**
 * Every route the site has, in one locale, with the entry that produced it.
 *
 * Three scripts need this list — the sitemap generator, the SEO audit and anything that later
 * wants to check internal links — and a route that exists in one of those lists but not the other
 * is precisely the drift this prevents. `status` is carried rather than filtered so the sitemap
 * can exclude a planned page while the audit still checks that the page itself is correct.
 */
export function siteRoutes(locale = null) {
  const site = loadSite(locale);
  const code = locale ?? site.defaultLocale;
  const tools = loadTools(code);
  const targets = loadTargets(tools, code);
  const pages = loadPages(code);

  const routes = [{ kind: 'home', status: 'live', path: '/', priority: '1.0' }];
  for (const tool of tools) {
    routes.push({ kind: 'tool', status: tool.status, path: toolPath(tool), priority: '0.8', entry: tool });
  }
  for (const target of targets) {
    routes.push({
      kind: 'target',
      status: target.status,
      path: targetPath(target),
      priority: '0.6',
      entry: target,
      tool: tools.find((tool) => tool.id === target.parentToolId),
    });
  }
  for (const page of pages) {
    routes.push({
      kind: 'page',
      status: page.status,
      path: pagePath(page),
      priority: page.priority.toFixed(1),
      entry: page,
    });
  }
  return { site, code, routes };
}
