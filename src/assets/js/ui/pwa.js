/**
 * Install and offline plumbing for the whole site: one service-worker registration, one cache
 * warm-up, and one install banner.
 *
 * Loaded by ui/site.js on every page, because an install prompt that only exists on the homepage is
 * an install prompt most visitors never see.
 *
 * **Registration is production-only.** The dev server serves the source tree, where the built shell
 * and hashed chunk names do not exist, so a worker registered there would cache URLs that are only
 * valid in a build. `import.meta.env.PROD` is what keeps the two apart, which also means the offline
 * behaviour can only be tested against a real build: `bun run build`, then `bun run preview`, then
 * the network-off check in qa/pwa-offline.mjs.
 *
 * **The warm-up exists because of a real gap.** A service worker installs *after* the page that
 * registered it has already fetched its CSS, JavaScript and worker script, so none of those requests
 * were intercepted and none of them are cached. Without a warm-up, "visit a tool, go offline, reload"
 * would land on the offline page instead of the tool. So once the worker is in control, the page
 * tells it which route it is on and the worker caches the precomputed bundle for it (see
 * scripts/gen-sw.mjs).
 *
 * **The banner waits for a reason to exist.** It appears only after an image has actually been
 * processed — a visitor who has already got something out of the site — and once dismissed it stays
 * dismissed. Chrome only fires `beforeinstallprompt` after its own engagement heuristics anyway
 * (one interaction and thirty seconds on the page), so this costs nothing in reach.
 */

import { t } from './strings.js';

const DISMISSED_KEY = 'browserimageeditor:install-dismissed';

/**
 * Dispatched by each tool once an image has been processed successfully. It is the signal the
 * banner waits for, and the reason no tool has to know anything about install prompts.
 */
export const PROCESSED_EVENT = 'browserimageeditor:processed';

let installPrompt = null;
let banner = null;
let delivered = false;

/** Exported so the tests can assert the storage key rather than guess it. */
export const INSTALL_DISMISSED_KEY = DISMISSED_KEY;

function readDismissed() {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    // Private browsing can throw on read; treating that as "not dismissed" shows the banner once.
    return false;
  }
}

function storeDismissed() {
  try {
    localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // Nothing to do: the banner is hidden for this page view either way.
  }
}

/** True when this page is already running as an installed app. */
export function isStandalone() {
  return (
    window.matchMedia?.('(display-mode: standalone)')?.matches === true ||
    window.navigator.standalone === true
  );
}

/** True on the offline fallback, which is not a page to be selling an install on. */
function isOfflinePage() {
  return Boolean(document.querySelector('[data-page-slug="offline"]'));
}

/**
 * The whole decision, in one pure function: every input is a fact and none of them touch the DOM.
 *
 * `delivered` is the "you have actually used this" flag, `hasPrompt` is the browser saying install is
 * possible, and the other three are the reasons to stay quiet.
 */
export function shouldOfferInstall({ hasPrompt, dismissed, standalone, delivered: used, offlinePage }) {
  return Boolean(hasPrompt) && !dismissed && !standalone && Boolean(used) && !offlinePage;
}

function buildBanner() {
  const element = document.createElement('aside');
  element.className = 'install-banner';
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-label', t('js.pwa.bannerLabel'));
  element.hidden = true;

  const text = document.createElement('p');
  text.className = 'install-banner-text';
  text.textContent = t('js.pwa.bannerText');

  const actions = document.createElement('div');
  actions.className = 'install-banner-actions';

  const install = document.createElement('button');
  install.type = 'button';
  install.className = 'button install-banner-install';
  install.dataset.installAccept = '';
  install.textContent = t('js.pwa.install');
  install.addEventListener('click', () => {
    void acceptInstall();
  });

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'button button-secondary';
  dismiss.dataset.installDismiss = '';
  dismiss.textContent = t('js.pwa.notNow');
  dismiss.addEventListener('click', () => {
    storeDismissed();
    hideBanner();
  });

  actions.append(install, dismiss);
  element.append(text, actions);
  document.body.append(element);
  return element;
}

function showBanner() {
  if (!shouldOfferInstall({
    hasPrompt: Boolean(installPrompt),
    dismissed: readDismissed(),
    standalone: isStandalone(),
    delivered,
    offlinePage: isOfflinePage(),
  })) {
    return;
  }
  banner ??= buildBanner();
  banner.hidden = false;
}

function hideBanner() {
  if (banner) banner.hidden = true;
}

async function acceptInstall() {
  if (!installPrompt) return;
  const prompt = installPrompt;
  // Cleared before awaiting: a prompt can only be used once, and a second click must not reuse it.
  installPrompt = null;
  hideBanner();
  try {
    await prompt.prompt();
    await prompt.userChoice;
  } catch {
    // The browser refused to show it (already installed, or the event went stale). Nothing to do.
  }
}

/**
 * The footer has a quiet "Install app" entry that stays hidden until the browser says install is
 * possible — the way back for anyone who dismissed the banner and changed their mind.
 */
function setFooterLinkVisible(visible) {
  document.querySelectorAll('[data-install-link]').forEach((element) => {
    element.hidden = !visible;
  });
}

export function markProcessed() {
  delivered = true;
  showBanner();
}

function initInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Chrome's own mini-infobar is suppressed in favour of this one, which knows whether the visitor
    // has actually used a tool yet and respects a dismissal.
    event.preventDefault();
    installPrompt = event;
    setFooterLinkVisible(true);
    showBanner();
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    hideBanner();
    setFooterLinkVisible(false);
    storeDismissed();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && banner && !banner.hidden) {
      storeDismissed();
      hideBanner();
    }
  });

  document.addEventListener(PROCESSED_EVENT, () => markProcessed());

  // The footer entry is a button rather than a link: installing is an action, not a navigation.
  document.querySelectorAll('[data-install-link]').forEach((element) => {
    element.addEventListener('click', () => {
      void acceptInstall();
    });
  });
}

function initServiceWorker() {
  const isProduction = Boolean(import.meta.env?.PROD);
  if (!isProduction || !('serviceWorker' in navigator)) return;

  const warm = () => {
    // `warm` is idempotent in the worker: anything already cached is left alone.
    navigator.serviceWorker.controller?.postMessage({ type: 'warm', path: window.location.pathname });
  };

  navigator.serviceWorker.addEventListener('controllerchange', warm);
  void navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then(() => navigator.serviceWorker.ready)
    .then(warm)
    .catch(() => {
      // A failed registration costs the offline behaviour and nothing else, so it is not surfaced:
      // every tool still works, which is the promise the page actually makes.
    });
}

export function initPwa() {
  initInstallPrompt();
  initServiceWorker();
}

