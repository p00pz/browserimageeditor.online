/**
 * Studio Shell — the one interaction layer every tool page shares.
 *
 * The six tool scripts were written against plain form controls: they read `.value`, they append
 * `<option>`s, they set `.disabled` and they listen for `change`. The shell wants those same
 * controls to look and feel like a modern studio — chips, sliders, steppers — without rewriting
 * six tool scripts and the hooks they share. So it never replaces a control: it presents it.
 *
 * Each presenter is wired to the hooked element the tool script already owns:
 *
 *   [data-shell-chips]            a <select> rendered as a segmented chip row
 *   [data-shell-chips-for=id]     static chips that write into the hooked input #id
 *   [data-shell-slider-for=id]    a range slider that writes into the hooked input #id
 *   [data-shell-readout-for=id]   a live label that mirrors a hooked input
 *   [data-shell-dual]             a chip that sets two dimension inputs at once
 *   [data-shell-lock="a|b"]       a toggle that couples two inputs by their current ratio
 *   [data-shell-step-for=id]      a +/- button that nudges a hooked input
 *
 * The hooked element keeps its value, keeps its `change` event, and stays the single source of
 * truth; a chip click writes to it and dispatches the event the tool script is already listening
 * for. Nothing here knows what a tool does, and no tool script imports this file.
 *
 * The shell is progressive: without JavaScript the page still works, because the hooked controls
 * are the real controls and they are served in the HTML.
 */

const MOBILE_DROP_CLASS = 'is-dragging';

/** Dispatches the event a tool script is already listening for. */
function announce(element) {
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Reads the options of a select as a flat list, keeping optgroup headings. */
function selectOptions(select) {
  const out = [];
  for (const child of select.children) {
    if (child instanceof HTMLOptGroupElement) {
      out.push({ group: child.label || '' });
      for (const option of child.children) {
        if (option instanceof HTMLOptionElement) out.push({ option });
      }
    } else if (child instanceof HTMLOptionElement) {
      // `child` is the option here; the optgroup branch's loop variable is not in scope.
      out.push({ option: child });
    }
  }
  return out;
}

/**
 * Renders a <select> as a segmented chip row.
 *
 * The select is the model: chips are built from its options, a chip click sets its value and
 * dispatches its `change`, and its `value` property is intercepted so a tool script setting it
 * programmatically (a target page's defaults) still moves the chip. Options appended later by a
 * tool script appear as chips through the MutationObserver, so a control that is populated at
 * runtime is populated here too.
 */
function presentSelect(select) {
  if (select.dataset.shellChips === 'done') return;
  select.dataset.shellChips = 'done';

  const label =
    select.closest('.field')?.querySelector('.field-label')?.textContent?.trim() ||
    select.getAttribute('aria-label') ||
    '';

  const group = document.createElement('div');
  group.className = 'chips shell-chips';
  group.setAttribute('role', 'radiogroup');
  if (label) group.setAttribute('aria-label', label);
  select.after(group);

  // The select stays as the value holder and leaves the accessibility tree: the radiogroup is the
  // interface now, and a visitor should never meet the same choice twice.
  select.classList.add('shell-host');
  select.setAttribute('aria-hidden', 'true');
  select.setAttribute('tabindex', '-1');

  /** Rebuilds the chips from the select's current options. Called on any structural change. */
  function build() {
    group.replaceChildren();
    for (const entry of selectOptions(select)) {
      if ('group' in entry) {
        const heading = document.createElement('span');
        heading.className = 'chips-group-label';
        heading.textContent = entry.group;
        group.append(heading);
        continue;
      }
      const option = entry.option;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.shellValue = option.value;
      chip.textContent = option.textContent;
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', String(option.selected));
      chip.disabled = select.disabled;
      group.append(chip);
    }
  }

  /** Marks the chip for the select's current value. */
  function sync() {
    for (const chip of group.querySelectorAll('.chip')) {
      chip.setAttribute('aria-checked', String(chip.dataset.shellValue === select.value));
    }
  }

  /** Selects a chip's value in the select and announces it, unless the select is disabled. */
  function choose(value) {
    if (select.disabled) return;
    if (select.value !== value) {
      select.value = value;
      announce(select);
    }
    sync();
  }

  group.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip || chip.disabled) return;
    choose(chip.dataset.shellValue);
  });

  // Arrow keys move through the group the way a native select does: the choice follows the focus.
  group.addEventListener('keydown', (event) => {
    const chips = [...group.querySelectorAll('.chip')].filter((chip) => !chip.disabled);
    if (chips.length === 0) return;
    const index = chips.indexOf(document.activeElement);
    let next = null;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = chips[(index + 1) % chips.length];
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = chips[(index - 1 + chips.length) % chips.length];
        break;
      case 'Home':
        next = chips[0];
        break;
      case 'End':
        next = chips[chips.length - 1];
        break;
    }
    if (!next) return;
    event.preventDefault();
    next.focus();
    choose(next.dataset.shellValue);
  });

  // A tool script sets `value` directly when a target page ships pre-filled defaults; without this,
  // the chip row would still show the first option.
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  if (descriptor && descriptor.set) {
    Object.defineProperty(select, 'value', {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value) {
        descriptor.set.call(select, value);
        sync();
      },
    });
  }

  const observer = new MutationObserver(() => {
    build();
    sync();
  });
  observer.observe(select, { childList: true, attributes: true, attributeFilter: ['disabled'] });

  build();
  sync();
}

/** Presents a hooked input as a slider plus a live readout. */
function presentSlider(root, input) {
  const slider = document.createElement('input');
  slider.type = 'range';
  // `slider` carries the cross-browser thumb styling shared with every other range on the site.
  slider.className = 'slider shell-slider';
  slider.min = root.dataset.min ?? '0';
  slider.max = root.dataset.max ?? '100';
  slider.step = root.dataset.step ?? '1';
  slider.value = input.value || slider.min;
  slider.setAttribute('aria-label', root.getAttribute('aria-label') || '');
  root.append(slider);

  const readout = root.querySelector('[data-shell-readout]');
  const format = (value) => root.dataset.format?.replace('{v}', value) ?? value;

  function paint() {
    if (readout) readout.textContent = input.value === '' ? (root.dataset.empty ?? '') : format(input.value);
    // A chip or a preset set the input from elsewhere; the thumb follows it back.
    if (input.value !== '') slider.value = input.value;
  }

  slider.addEventListener('input', () => {
    if (input.disabled) return;
    input.value = slider.value;
    if (readout) readout.textContent = format(input.value);
  });
  // `change` fires when the thumb is released; that is the moment a tool re-runs, so the work
  // happens once per gesture instead of once per pixel of drag.
  slider.addEventListener('change', () => {
    if (input.disabled) return;
    announce(input);
  });

  // Chips and presets dispatch `change` on the input when they write to it, which is enough to
  // repaint: `value` is a property, so a MutationObserver on attributes would never fire here.
  input.addEventListener('change', paint);
  paint();
}

/**
 * Static chips that write into one hooked input. The empty value is the "original"/"auto" choice:
 * it clears the input, which is what `parseDimension` and `parseTargetBytes` read as "no opinion".
 */
function presentChipsFor(group, input) {
  const emptyLabel = group.dataset.empty ?? '';

  function sync() {
    for (const chip of group.querySelectorAll('[data-shell-value]')) {
      const on = chip.dataset.shellValue === input.value;
      chip.setAttribute('aria-pressed', String(on));
    }
    if (input.value === '' && emptyLabel) {
      group.querySelector('[data-shell-value=""]')?.setAttribute('aria-pressed', 'true');
    }
  }

  group.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-shell-value]');
    if (!chip || chip.disabled || input.disabled) return;
    input.value = chip.dataset.shellValue;
    announce(input);
    sync();
  });

  // Chips dispatch `change` on the input when they write to it, so this is the single hook that
  // keeps the row in step; `value` is a property, so an attribute observer would never fire.
  input.addEventListener('change', sync);
  sync();
}

/** A chip that sets two dimension inputs at once (a preset like 1920×1080). */
function presentDualChip(chip) {
  const width = document.querySelector(chip.dataset.width);
  const height = document.querySelector(chip.dataset.height);
  if (!width || !height) return;
  chip.addEventListener('click', () => {
    if (chip.disabled || width.disabled || height.disabled) return;
    width.value = chip.dataset.w ?? '';
    height.value = chip.dataset.h ?? '';
    announce(width);
    announce(height);
  });
}

/**
 * Couples two dimension inputs. The ratio is captured the moment a pair is complete — a preset
 * chip fills both, or a visitor finishes typing the second one — and held from there, so a later
 * edit to either side re-derives the other. Clearing either side forgets the ratio, because an
 * empty side is the "original" choice and has no proportion to keep.
 *
 * The lock is on by default, matching the site's existing convention, and stays armed rather than
 * engaged: with both sides empty there is no ratio to hold, so nothing happens until there is.
 */
function presentLock(button) {
  const [widthSel, heightSel] = (button.dataset.shellLock || '').split('|');
  const width = document.querySelector(widthSel);
  const height = document.querySelector(heightSel);
  if (!width || !height) return;

  let ratio = null;
  let armed = Boolean(button.dataset.on);
  button.setAttribute('aria-pressed', 'false');

  function sync() {
    const w = Number(width.value);
    const h = Number(height.value);
    if (armed && w > 0 && h > 0 && ratio === null) {
      // A pair just completed: this is the proportion to keep.
      ratio = w / h;
      button.setAttribute('aria-pressed', 'true');
    } else if ((!(w > 0) || !(h > 0)) && ratio !== null) {
      ratio = null;
      button.setAttribute('aria-pressed', String(armed));
    }
  }

  button.addEventListener('click', () => {
    armed = !armed;
    ratio = null;
    button.setAttribute('aria-pressed', String(armed && Number(width.value) > 0 && Number(height.value) > 0));
  });

  width.addEventListener('change', () => {
    sync();
    if (ratio === null) return;
    const h = Number(height.value);
    const w = Number(width.value);
    if (w > 0) height.value = String(Math.max(1, Math.round(w / ratio)));
  });
  height.addEventListener('change', () => {
    sync();
    if (ratio === null) return;
    const w = Number(width.value);
    const h = Number(height.value);
    if (h > 0) width.value = String(Math.max(1, Math.round(h * ratio)));
  });

  sync();
}

/** A +/- stepper that nudges a hooked numeric input by a fixed amount. */
function presentStepper(button) {
  const input = document.querySelector(button.dataset.shellStepFor);
  if (!input) return;
  const step = Number(button.dataset.step || '1');
  button.addEventListener('click', () => {
    if (button.disabled || input.disabled) return;
    const current = Number(input.value);
    const next = Math.max(1, (Number.isFinite(current) ? current : 0) + step);
    input.value = String(Math.round(next));
    announce(input);
  });
}

/**
 * Highlights the drop surface while a file is dragged anywhere over the studio, so the whole page
 * reads as a target even though the dropzone itself is the element that catches the drop.
 */
function presentStudio(studio) {
  const dropzone = studio.querySelector('[data-dropzone]');
  if (!dropzone) return;
  studio.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dropzone.classList.add(MOBILE_DROP_CLASS);
  });
  studio.addEventListener('dragover', (event) => event.preventDefault());
  studio.addEventListener('dragleave', (event) => {
    if (event.relatedTarget && studio.contains(event.relatedTarget)) return;
    dropzone.classList.remove(MOBILE_DROP_CLASS);
  });
  studio.addEventListener('drop', (event) => {
    // A drop on the dropzone itself is already handled by its own listener; forwarding it would
    // run the same files through twice.
    if (dropzone.contains(event.target)) return;
    event.preventDefault();
    dropzone.classList.remove(MOBILE_DROP_CLASS);
    // A drop anywhere else on the studio is handed to the dropzone's own handler, which already
    // knows how to validate and forward it — the shell never touches a File itself.
    if (event.dataTransfer?.files?.length) {
      dropzone.dispatchEvent(new DragEvent('drop', { dataTransfer: event.dataTransfer, bubbles: true }));
    }
  });
}

/** Wires every presenter in a studio. Called once per tool page; safe to call on a partial page. */
export function initStudio(scope = document) {
  for (const select of scope.querySelectorAll('select[data-shell-chips]')) presentSelect(select);
  for (const group of scope.querySelectorAll('[data-shell-chips-for]')) {
    const input = scope.querySelector(`[data-${group.dataset.shellChipsFor}]`);
    if (input) presentChipsFor(group, input);
  }
  for (const root of scope.querySelectorAll('[data-shell-slider]')) {
    const input = scope.querySelector(`[data-${root.dataset.shellSlider}]`);
    if (input) presentSlider(root, input);
  }
  for (const chip of scope.querySelectorAll('[data-shell-dual]')) presentDualChip(chip);
  for (const button of scope.querySelectorAll('[data-shell-lock]')) presentLock(button);
  for (const button of scope.querySelectorAll('[data-shell-step-for]')) presentStepper(button);
  for (const studio of scope.querySelectorAll('[data-tool-root]')) presentStudio(studio);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => initStudio(), { once: true });
} else {
  initStudio();
}
