/**
 * Site chrome shared by every page: colour scheme, mobile menu, footer year.
 *
 * These wire up the data attributes that already exist in src/partials/header.html and
 * footer.html (`data-theme-toggle`, `data-mobile-menu-toggle`, `data-year`). The theme
 * class names and storage key must match src/partials/theme-boot.html, which applies the
 * same choice before first paint.
 */

import { t } from './strings.js';
import { initDiscovery } from './discovery.js';
import { initPwa } from './pwa.js';

// The renamed settings key means existing users will need to choose their theme once again.
const THEME_KEY = 'browserimageeditor:theme';

function readStoredTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    return null;
  }
}

function storeTheme(theme) {
  try {
    if (theme) localStorage.setItem(THEME_KEY, theme);
    else localStorage.removeItem(THEME_KEY);
  } catch {
    // Storage can throw in private browsing; the theme still applies for this page view.
  }
}

function systemTheme() {
  const query = window.matchMedia?.('(prefers-color-scheme: dark)');
  return query?.matches ? 'dark' : 'light';
}

function applyTheme(theme) {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.classList.toggle('light', theme === 'light');
}

function initTheme() {
  const toggle = document.querySelector('[data-theme-toggle]');
  applyTheme(readStoredTheme() ?? systemTheme());
  if (toggle) {
    toggle.setAttribute('aria-pressed', String(document.documentElement.classList.contains('dark')));
    toggle.addEventListener('click', () => {
      const next = document.documentElement.classList.contains('dark') ? 'light' : 'dark';
      applyTheme(next);
      storeTheme(next);
      toggle.setAttribute('aria-pressed', String(next === 'dark'));
    });
  }

  window.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', () => {
    if (readStoredTheme() === null) applyTheme(systemTheme());
  });
}

function initMobileMenu() {
  const toggle = document.querySelector('[data-mobile-menu-toggle]');
  // `.nav-sheet`, not `.nav`: the sheet is the body-level copy, outside the header, because a
  // `backdrop-filter` on an ancestor makes it the containing block for fixed descendants and the
  // sheet would be pinned to the header's box instead of the viewport. See layout.css.
  const nav = document.querySelector('.nav-sheet');
  if (!toggle || !nav) return;

  let lastFocus = null;

  function focusables() {
    return [...nav.querySelectorAll('a[href], button:not([disabled])')].filter(
      (element) => element.offsetParent !== null,
    );
  }

  function setOpen(open) {
    nav.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    // The label a screen reader announces is part of the page's language, so it comes from the
    // page's own catalogue rather than a literal. Both catalogues hold the same English words,
    // so this changes nothing on an English page.
    toggle.setAttribute('aria-label', t(open ? 'js.chrome.menuClose' : 'js.chrome.menuOpen'));
    // The page behind an open sheet is not content to be scrolled to; it is a backdrop.
    document.body.style.overflow = open ? 'hidden' : '';
    if (open) {
      lastFocus = document.activeElement;
      focusables()[0]?.focus();
    } else if (lastFocus && document.contains(lastFocus)) {
      // Returning focus is part of closing a dialog, not a nicety.
      lastFocus.focus();
      lastFocus = null;
    }
  }

  window.matchMedia('(min-width: 768px)').addEventListener('change', (event) => {
    if (event.matches && nav.classList.contains('is-open')) setOpen(false);
  });
  setOpen(false);
  toggle.addEventListener('click', () => setOpen(!nav.classList.contains('is-open')));
  nav.addEventListener('click', (event) => {
    // A tap on any link is a navigation, so the sheet is done.
    if (event.target instanceof Element && event.target.closest('a')) setOpen(false);
  });
  // Tap on the page above the sheet closes it; the toggle and the sheet itself are not the page.
  document.addEventListener('pointerdown', (event) => {
    if (!nav.classList.contains('is-open')) return;
    if (nav.contains(event.target) || toggle.contains(event.target)) return;
    setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (!nav.classList.contains('is-open')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key !== 'Tab') return;
    const list = focusables();
    if (list.length === 0) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

/**
 * Points the header's language switch at this page's counterpart.
 *
 * The switch is one partial per locale, so its static href can only be the other language's
 * homepage. Every page already declares its real counterparts in `<link rel="alternate">`, so the
 * link is corrected here from that declaration. A route with no counterpart keeps the homepage and
 * the explanatory `title` the partial ships with — the same behaviour the per-page switch had.
 */
function initLangSwitch() {
  // There are two switches in the DOM: the header copy and the menu-sheet copy. Both must resolve,
  // so this walks every instance rather than the first one it finds.
  for (const langSwitch of document.querySelectorAll('[data-lang-switch]')) {
    for (const link of langSwitch.querySelectorAll('[data-lang-target]')) {
      const alternate = document.querySelector(
        `link[rel="alternate"][hreflang="${CSS.escape(link.dataset.langTarget)}"]`,
      );
      if (!alternate) continue;
      const href = alternate.getAttribute('href');
      if (!href) continue;
      try {
        const url = new URL(href, location.href);
        // Same-origin stays relative, which keeps the link working offline and behind the service
        // worker; a different origin is left exactly as declared.
        link.href = url.origin === location.origin ? `${url.pathname}${url.search}${url.hash}` : href;
      } catch {
        link.href = href;
      }
      // This page has a real counterpart, so the "not translated yet" explanation no longer applies.
      link.removeAttribute('title');
    }
  }
}

function initFooterYear() {
  const year = String(new Date().getFullYear());
  document.querySelectorAll('[data-year]').forEach((element) => {
    element.textContent = year;
  });
}

export function initSite() {
  initTheme();
  initLangSwitch();
  initMobileMenu();
  initFooterYear();
  initDiscovery();
  // Offline registration and the install prompt. Nothing here is needed for a tool to work, which is
  // why it is initialised last and why a failure inside it is not surfaced to the visitor.
  initPwa();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSite, { once: true });
  } else {
    initSite();
  }
}
