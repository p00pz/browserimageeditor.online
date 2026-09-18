/**
 * Progress component. Owns the visibility of the progress region, the width of the bar and
 * the aria-valuenow that screen readers announce.
 *
 * The label comes from the caller, which reads it from the string catalogue: this component is
 * shared by five tools and has no business knowing which verb is in progress.
 */
import { t } from './strings.js';

export function createProgress(region, { label = t('js.common.done') } = {}) {
  if (!region) throw new Error('createProgress: a region element is required.');

  const track = region.querySelector('[data-progress]');
  const bar = region.querySelector('[data-progress-bar]');
  const text = region.querySelector('[data-progress-text]');

  function set(ratio, message) {
    const percent = Math.round(Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0)) * 100);
    if (bar) bar.style.width = `${percent}%`;
    if (track) track.setAttribute('aria-valuenow', String(percent));
    if (text) text.textContent = message ?? label;
  }

  return {
    start(message) {
      region.hidden = false;
      set(0, message ?? label);
    },
    set,
    finish(message = t('js.common.done')) {
      set(1, message);
    },
    hide() {
      region.hidden = true;
      set(0, label);
    },
  };
}
