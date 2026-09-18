/**
 * Site chrome shared by every page: colour scheme, mobile menu, footer year.
 *
 * These wire up the data attributes that already exist in src/partials/header.html and
 * footer.html (`data-theme-toggle`, `data-mobile-menu-toggle`, `data-year`). The theme
 * class names and storage key must match src/partials/theme-boot.html, which applies the
 * same choice before first paint.
 */

import { t } from './strings.js';
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
  const nav = document.querySelector('.nav');
  if (!toggle || !nav) return;

  function setOpen(open) {
    nav.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    // The label a screen reader announces is part of the page's language, so it comes from the
    // page's own catalogue rather than a literal. Both catalogues hold the same English words,
    // so this changes nothing on an English page.
    toggle.setAttribute('aria-label', t(open ? 'js.chrome.menuClose' : 'js.chrome.menuOpen'));
  }

  setOpen(false);
  toggle.addEventListener('click', () => setOpen(!nav.classList.contains('is-open')));
  nav.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('a')) setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false);
  });
}

function initFooterYear() {
  const year = String(new Date().getFullYear());
  document.querySelectorAll('[data-year]').forEach((element) => {
    element.textContent = year;
  });
}

export function initSite() {
  initTheme();
  initMobileMenu();
  initFooterYear();
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
