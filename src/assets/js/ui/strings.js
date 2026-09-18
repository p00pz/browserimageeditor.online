/**
 * Runtime strings.
 *
 * Every sentence the interface says at runtime comes from the page's own `#ui-strings` block, which
 * `scripts/build-pages.mjs` fills from `content/ui.json` overlaid with `content/<locale>/ui.json`.
 * Nothing here reads a language preference at run time: the language is decided when the page is
 * generated, so a page is entirely one language and there is no moment where a toolbar is Arabic and
 * a status line is English.
 *
 * Three deliberate choices:
 *
 *   - **Inline, not fetched.** The catalogue is a JSON block in the HTML. A fetch would be one more
 *     request between paint and ready text, and it would be a request that has to succeed offline,
 *     which is exactly the thing the service worker exists to make unnecessary.
 *   - **A missing key is loud.** It warns in the console and returns the key itself, so a typo shows
 *     up as `js.compress.ready` on the page rather than as an empty string nobody notices. The
 *     build-time side is stricter still: a template token with no value fails the build.
 *   - **`{name}` interpolation, never concatenation.** Word order differs between languages, so
 *     "Compressing {name} in your browser…" is one string per language rather than a prefix and a
 *     suffix glued around a translated filename in code.
 *
 * The exported `t` is bound to the page's catalogue, which is what a shared component like the
 * dropzone or the install banner wants; `createStrings(map)` exists so tests (and any future
 * non-DOM caller) can use the same interpolation without a document.
 */

const ELEMENT_ID = 'ui-strings';

let bound = null;
let loaded = false;
const warned = new Set();

/** Substitutes `{name}` values. A missing one is left visible rather than blanked. */
export function interpolate(template, vars) {
  if (!vars) return template;
  return String(template).replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

/**
 * Reads the injected catalogue once per document.
 *
 * A malformed block is treated as an empty catalogue rather than throwing: a page with an empty
 * status line is a page someone can still use and report, while a page that throws on load is not.
 */
function load() {
  if (loaded) return bound ?? {};
  loaded = true;
  try {
    const element = document.getElementById(ELEMENT_ID);
    const parsed = element ? JSON.parse(element.textContent) : null;
    bound = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.warn(`[strings] the ${ELEMENT_ID} block could not be read; falling back to key names.`, error);
    bound = {};
  }
  return bound;
}

/**
 * Builds a lookup over a string map.
 *
 *   t('js.compress.ready')                       -> "Ready — drop an image…"
 *   t('js.common.savedFile', { name, size })     -> "Saved photo.jpg (96 KB)."
 */
export function createStrings(map) {
  const strings = map ?? load();
  return (key, vars) => {
    const template = strings[key];
    if (typeof template !== 'string') {
      if (!warned.has(key)) {
        warned.add(key);
        console.warn(`[strings] no value for "${key}" in this page's catalogue.`);
      }
      return key;
    }
    return interpolate(template, vars);
  };
}

/** True when a key exists, for the few call sites that prefer silence over a missing-key warning. */
export function hasString(key) {
  return typeof (bound ?? load())[key] === 'string';
}

/**
 * The catalogue bound to this document. Components import this directly; tool scripts are free to
 * call `createStrings()` themselves, which is what tests do.
 */
export const t = (key, vars) => createStrings()(key, vars);

/**
 * The text to show for an error, given its code.
 *
 * The engines throw English sentences alongside a stable `code`, and the code is the part worth
 * translating: it is the one thing that is the same in every language and does not drift when
 * someone rewrites a message. So the catalogue is consulted first, and the engine's own sentence is
 * the fallback — which is what keeps an untranslated code readable rather than showing `ENCODE_FAILED`
 * to a visitor.
 */
export function localizeError(code, fallback) {
  const key = `js.error.${code}`;
  if (code && hasString(key)) return t(key);
  return fallback;
}

/** The whole map, for a caller that needs to iterate (the i18n test does). */
export function allStrings() {
  return { ...load() };
}
