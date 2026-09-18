/**
 * Before/after compare slider.
 *
 * It drives the CSS contract that was already in components.css: the component only sets
 * `--compare-position` on the root, and the clip on `.compare-slider-after` plus the handle's
 * `left` follow from it. No layout math is duplicated here.
 *
 * Input handling is deliberately two-layered:
 *   - a visually hidden `input[type="range"]` inside the root carries the value, which gives
 *     keyboard support (Tab, arrow keys) and screen-reader semantics for free;
 *   - pointer events on the root give a drag that works anywhere in the box, not just on an
 *     invisible thumb. A click also focuses the range, so arrows work straight afterwards.
 *
 * The component owns no URLs: the caller creates and revokes those, because it also has to
 * revoke them when the selection changes.
 */
import { estimateSavings } from '../core/engine-compress.js';
import { formatBytes, formatSignedPercent } from './format.js';
import { t } from './strings.js';

/** "2.4 MB → 96 KB (-96%)". Returns '' when there is nothing meaningful to show. */
export function formatSavings(beforeBytes, afterBytes) {
  if (!Number.isFinite(beforeBytes) || beforeBytes <= 0 || !Number.isFinite(afterBytes) || afterBytes < 0) {
    return '';
  }
  const savings = estimateSavings(beforeBytes, afterBytes);
  return `${formatBytes(beforeBytes)} → ${formatBytes(afterBytes)} (${formatSignedPercent(savings.percent)})`;
}

export function createCompareSlider(
  root,
  { input = null, before = null, after = null, savings = null, position = 50, onChange } = {},
) {
  if (!root) throw new Error('createCompareSlider: a root element is required.');

  const rangeInput = input ?? root.querySelector('[data-compare-input]');
  const beforeImage = before ?? root.querySelector('[data-compare-before]');
  const afterImage = after ?? root.querySelector('[data-compare-after]');
  const savingsLine = savings ?? root.querySelector('[data-compare-savings]');

  const min = Number.isFinite(Number(rangeInput?.min)) ? Number(rangeInput.min) : 0;
  const max = Number.isFinite(Number(rangeInput?.max)) ? Number(rangeInput.max) : 100;

  let dragging = false;
  let current = clamp(position);

  function clamp(value) {
    if (!Number.isFinite(value)) return 50;
    return Math.min(max, Math.max(min, value));
  }

  function setPosition(value) {
    current = clamp(value);
    root.style.setProperty('--compare-position', `${current}%`);
    if (rangeInput) {
      const rounded = String(Math.round(current));
      if (rangeInput.value !== rounded) rangeInput.value = rounded;
      // A screen-reader string, so it comes from the catalogue like any other text. The percentage
      // stays a Western numeral and rtl.css isolates it, so it cannot reorder inside Arabic text.
      rangeInput.setAttribute(
        'aria-valuetext',
        t('js.common.compareSliderValue', { percent: Math.round(current) }),
      );
    }
    onChange?.(current);
  }

  function positionFromEvent(event) {
    const rect = root.getBoundingClientRect();
    if (!rect.width) return current;
    const ratio = (event.clientX - rect.left) / rect.width;
    return min + Math.min(1, Math.max(0, ratio)) * (max - min);
  }

  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    dragging = true;
    root.setPointerCapture?.(event.pointerId);
    rangeInput?.focus({ preventScroll: true });
    setPosition(positionFromEvent(event));
    // Stops the browser from starting a native image drag when a pane is grabbed.
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!dragging) return;
    setPosition(positionFromEvent(event));
  }

  function onPointerUp(event) {
    if (!dragging) return;
    dragging = false;
    root.releasePointerCapture?.(event.pointerId);
  }

  function onRangeInput() {
    setPosition(Number(rangeInput.value));
  }

  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerup', onPointerUp);
  root.addEventListener('pointercancel', onPointerUp);
  rangeInput?.addEventListener('input', onRangeInput);
  setPosition(current);

  return {
    /** Shows a new "before" image. Pass null to clear it. */
    setBefore(url) {
      if (!beforeImage) return;
      if (url) beforeImage.src = url;
      else beforeImage.removeAttribute('src');
    },
    setAfter(url) {
      if (!afterImage) return;
      if (url) afterImage.src = url;
      else afterImage.removeAttribute('src');
    },
    /** Renders the savings readout and returns the text it wrote. */
    setSavings(beforeBytes, afterBytes) {
      const text = formatSavings(beforeBytes, afterBytes);
      if (savingsLine) {
        savingsLine.textContent = text;
        savingsLine.hidden = text === '';
      }
      return text;
    },
    setPosition,
    setVisible(visible) {
      root.hidden = !visible;
    },
    get position() {
      return current;
    },
    reset() {
      this.setBefore(null);
      this.setAfter(null);
      this.setSavings(Number.NaN, Number.NaN);
      setPosition(50);
    },
    destroy() {
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('pointermove', onPointerMove);
      root.removeEventListener('pointerup', onPointerUp);
      root.removeEventListener('pointercancel', onPointerUp);
      rangeInput?.removeEventListener('input', onRangeInput);
    },
  };
}
