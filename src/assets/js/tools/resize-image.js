/**
 * Resize tool wiring — the same shape as tools/compress-image.js:
 * dropzone -> core/queue.js -> resize.worker.js -> compare slider -> core/file-io.js.
 *
 * Nothing here does image work, and nothing here is a second implementation of anything: the
 * dropzone, the queue, the ZIP writer and the slider are all the Phase 0/1 components, and the
 * sizing arithmetic lives in core/engine-resize.js where it can be tested without a browser.
 *
 * Preset sizes come from core/presets.js, which records where each number came from. Presets fill
 * the width/height inputs and then disable them, so a preset cannot be half-applied by editing one
 * box afterwards; "Custom size" hands the boxes back to you.
 */
import { CompressError } from '../core/engine-compress.js';
import { openEngine } from '../core/worker-or-main.js';
import { scalePercent } from '../core/engine-resize.js';
import { findResizePreset, groupedResizePresets } from '../core/presets.js';
import { createQueue } from '../core/queue.js';
import { downloadZip, toBytes, totalBytes, zipNameFor } from '../core/file-io.js';
import { primePhotosVariant, saveBatchOrZip, saveBlob, wireDownloadAnchor } from '../core/save-photo.js';
import { createCompareSlider } from '../ui/compare-slider.js';
import { createDropzone } from '../ui/dropzone.js';
import { formatBytes, formatSignedPercent } from '../ui/format.js';
import { createProgress } from '../ui/progress.js';
import { markProcessed } from '../ui/pwa.js';
import { hasString, localizeError, t } from '../ui/strings.js';

const PHASE_MESSAGES = {
  probe: t('js.resize.phaseProbe'),
  resize: t('js.resize.phaseResize'),
  encode: t('js.resize.phaseEncode'),
};

/** Two at a time: a memory bound rather than a tuning knob (see core/queue.js). */
const CONCURRENCY = 2;

/**
 * The width at which the primary action leaves the batch row and becomes a fixed bar at the bottom of
 * the viewport. It has to stay in step with the `max-width: 767px` block in components.css.
 *
 * Every tool script states it once rather than importing it, because a shared module for one string
 * would be a dependency between five files that otherwise share nothing but their worker boundary.
 */
const MOBILE_QUERY = '(max-width: 767px)';

const ZIP_SUFFIX = '-resized';
const ZIP_NAME = 'browserimageeditor-resized.zip';

function readConfig() {
  const element = document.getElementById('tool-config');
  if (!element) throw new Error('resize-image: this page is missing its #tool-config block.');
  return JSON.parse(element.textContent);
}

function init() {
  const root = document.querySelector('[data-tool-root]');
  if (!root) return;

  const config = readConfig();
  // A target landing page (/targets/<slug>/) ships this panel pre-configured, and tool pages send
  // no "defaults" key at all. Filling a control is all this does: it must never start a run, since
  // nothing has been dropped yet.
  const defaults = config.defaults ?? {};
  const dropzoneRoot = root.querySelector('[data-dropzone]');
  const presetSelect = root.querySelector('[data-preset]');
  const widthInput = root.querySelector('[data-width]');
  const heightInput = root.querySelector('[data-height]');
  const formatSelect = root.querySelector('[data-output-format]');
  const lockInput = root.querySelector('[data-lock-aspect]');
  const upscaleInput = root.querySelector('[data-allow-upscale]');
  const presetNote = root.querySelector('[data-preset-note]');
  const unsupportedNotice = root.querySelector('[data-unsupported]');
  const batchRegion = root.querySelector('[data-batch]');
  const batchSummary = root.querySelector('[data-batch-summary]');
  const batchActions = root.querySelector('[data-batch-actions]');
  const resizeAllButton = root.querySelector('[data-resize-all]');
  /**
   * The run button's two labels travel with the button rather than being looked up in the catalogue.
   * They are written into the markup from `content/ui.json` at build time, so this file never has to
   * know which language it is running in — and there is exactly one place a "Resize all" label is
   * authored instead of a markup copy and a runtime copy that can drift apart.
   */
  const runLabel = resizeAllButton?.dataset.label ?? '';
  const runAgainLabel = resizeAllButton?.dataset.labelDone ?? runLabel;
  const zipButton = root.querySelector('[data-download-zip]');
  const fileList = root.querySelector('[data-file-list]');
  const progressRegion = root.querySelector('[data-progress-region]');
  const cancelButton = root.querySelector('[data-cancel]');
  const resultPanel = root.querySelector('[data-result]');
  const statusLine = root.querySelector('[data-status]');

  if (!dropzoneRoot || !widthInput || !heightInput || !progressRegion || !resultPanel || !statusLine || !fileList) {
    throw new Error('resize-image: this page is missing elements the tool needs.');
  }

  const progress = createProgress(progressRegion, { label: t('js.resize.running') });
  const compare = createCompareSlider(root.querySelector('[data-compare]'), {
    savings: root.querySelector('[data-compare-savings]'),
  });

  const result = {
    dimensions: resultPanel.querySelector('[data-result-dimensions]'),
    size: resultPanel.querySelector('[data-result-size]'),
    scale: resultPanel.querySelector('[data-result-scale]'),
    warning: resultPanel.querySelector('[data-result-warning]'),
    download: resultPanel.querySelector('[data-download]'),
  };

  for (const mime of config.outputs ?? []) {
    const option = document.createElement('option');
    option.value = mime;
    option.textContent = config.outputLabels?.[mime] ?? mime;
    option.selected = mime === config.defaultOutput;
    formatSelect?.append(option);
  }

  if (presetSelect) {
    for (const group of groupedResizePresets()) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = group.name;
      for (const preset of group.presets) {
        const option = document.createElement('option');
        option.value = preset.id;
        // The preset's own label comes from the catalogue by id, so the dropdown speaks the page's
        // language while the dimensions stay platform facts.
        option.textContent = `${presetLabel(preset)} — ${preset.width}×${preset.height}`;
        optgroup.append(option);
      }
      presetSelect.append(optgroup);
    }

    // A preset default fills the width/height boxes, disables them and shows the preset's sourced
    // note — exactly what choosing it by hand does. A manual size default just fills the boxes.
    if (defaults.presetId && findResizePreset(defaults.presetId)) {
      presetSelect.value = defaults.presetId;
      applyPreset();
    } else {
      if (Number.isInteger(defaults.width)) widthInput.value = String(defaults.width);
      if (Number.isInteger(defaults.height)) heightInput.value = String(defaults.height);
    }
  }

  /** item id -> { row, refs, phaseText } */
  const rows = new Map();
  const reporters = new Map();
  const byIdLatest = new Map();

  let worker = null;
  let api = null;
  let progressProxy = null;
  let queue = null;
  let currentFiles = [];
  let selectedId = null;
  let previewUrls = { before: null, after: null };
  let busy = false;
  let ready = false;

  function announce(message, tone = 'info') {
    statusLine.textContent = message;
    statusLine.classList.toggle('is-error', tone === 'error');
  }

  /* ---------- worker ---------- */

  /**
   * A preset's display name, from the catalogue by preset id.
   *
   * The dimension tables in core/presets.js stay pure data — they are facts about what platforms
   * ask for, with a citation each, and a translated label living next to them would be the place
   * an engine starts having opinions about language. A preset with no translation falls back to its
   * English label rather than to a key name.
   */
  function presetLabel(preset) {
    const key = `js.preset.${preset.id}`;
    return hasString(key) ? t(key) : preset.label;
  }

  function ensureWorker() {
    if (api) return api;
    // See compress-image.js: the worker is constructed here so the bundler can resolve it.
    worker = new Worker(new URL('../workers/resize.worker.js', import.meta.url), { type: 'module' });
    api = openEngine('resize', worker, {
      onError: () => announce(t('js.resize.workerStopped'), 'error'),
    });
    progressProxy = handleProgress;
    return api;
  }

  function handleProgress(update) {
    if (!update || !update.jobId) return;
    const entry = rows.get(update.jobId);
    if (entry) entry.phaseText = PHASE_MESSAGES[update.phase] ?? entry.phaseText;
    reporters.get(update.jobId)?.(update.ratio ?? 0);
  }

  function normalizeRejection(error) {
    if (error && typeof error === 'object' && typeof error.code === 'string') {
      return new CompressError(error.code, localizeError(error.code, error.message ?? t('js.resize.failed')));
    }
    return new CompressError(
      'INTERNAL',
      localizeError('INTERNAL', error?.message ?? t('js.resize.failedUnknown')),
    );
  }

  function readOptions() {
    return {
      outputMime: formatSelect?.value || config.defaultOutput,
      width: widthInput.value.trim() === '' ? null : Number(widthInput.value),
      height: heightInput.value.trim() === '' ? null : Number(heightInput.value),
      lockAspect: lockInput ? lockInput.checked : true,
      allowUpscale: upscaleInput ? upscaleInput.checked : false,
    };
  }

  async function runFile(file, { id, signal, report }) {
    if (signal.aborted) throw new CompressError('ABORTED', t('js.common.cancelledBeforeStart'));

    const client = ensureWorker();
    const options = readOptions();
    const forwardAbort = () => {
      void client.cancel(id);
    };
    signal.addEventListener('abort', forwardAbort, { once: true });
    reporters.set(id, report);

    try {
      return await client.resize({ jobId: id, file, options }, progressProxy);
    } catch (error) {
      throw normalizeRejection(error);
    } finally {
      reporters.delete(id);
      signal.removeEventListener('abort', forwardAbort);
    }
  }

  /* ---------- rows ---------- */

  function button(label, className, onClick) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = className;
    element.textContent = label;
    element.addEventListener('click', onClick);
    return element;
  }

  function createRow(item) {
    const row = document.createElement('li');
    row.className = 'batch-item';
    row.dataset.jobId = item.id;

    const main = document.createElement('div');
    main.className = 'batch-item-main';
    const name = document.createElement('span');
    name.className = 'batch-item-name';
    name.textContent = item.file?.name || 'image';
    const meta = document.createElement('span');
    meta.className = 'batch-item-meta';
    main.append(name, meta);

    const track = document.createElement('div');
    track.className = 'progress';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', '0');
    track.setAttribute('aria-label', t('js.common.progressFor', { name: item.file?.name || t('js.common.imageOne') }));
    const bar = document.createElement('div');
    bar.className = 'progress-bar';
    track.append(bar);

    const status = document.createElement('p');
    status.className = 'batch-item-status';

    const actions = document.createElement('div');
    actions.className = 'batch-item-actions';
    const compareButton = button(t('js.common.compare'), 'button button-secondary', () => selectItem(item.id));
    const downloadButton = button(t('js.common.download'), 'button button-secondary', () => downloadItem(item.id));
    const retryButton = button(t('js.common.retry'), 'button button-secondary', () => retryItem(item.id));
    compareButton.hidden = true;
    downloadButton.hidden = true;
    retryButton.hidden = true;
    actions.append(compareButton, downloadButton, retryButton);

    row.append(main, track, status, actions);
    return { row, refs: { meta, status, track, bar, compareButton, downloadButton, retryButton }, phaseText: '' };
  }

  function updateRow(item, entry) {
    const { refs } = entry;
    const percent = Math.round((item.ratio ?? 0) * 100);
    refs.bar.style.width = `${percent}%`;
    refs.track.setAttribute('aria-valuenow', String(percent));
    entry.row.dataset.status = item.status;
    entry.row.dataset.selected = item.id === selectedId ? 'true' : 'false';

    const sourceSize = formatBytes(item.file?.size ?? 0);
    refs.status.classList.remove('is-error', 'is-success');
    refs.compareButton.hidden = true;
    refs.downloadButton.hidden = true;
    refs.retryButton.hidden = true;

    if (item.status === 'queued') {
      refs.meta.textContent = sourceSize;
      refs.status.textContent = t('js.common.waiting');
      return;
    }

    if (item.status === 'running') {
      refs.meta.textContent = sourceSize;
      refs.status.textContent = entry.phaseText || t('js.resize.running');
      return;
    }

    if (item.status === 'done' && item.result) {
      const meta = item.result.meta;
      refs.meta.textContent = `${meta.sourceWidth}×${meta.sourceHeight} → ${meta.width}×${meta.height}`;
      const change = formatBytes(meta.sourceBytes) === formatBytes(meta.bytes)
        ? `${formatBytes(meta.bytes)}`
        : `${formatBytes(meta.sourceBytes)} → ${formatBytes(meta.bytes)}`;
      refs.status.textContent = meta.scaled
        ? t('js.resize.doneScaled', { change })
        : t('js.resize.doneUnchanged', { change });
      refs.status.classList.add('is-success');
      refs.compareButton.hidden = false;
      refs.downloadButton.hidden = false;
      return;
    }

    refs.meta.textContent = sourceSize;
    refs.status.textContent = item.error?.message ?? t('js.common.somethingWrong');
    refs.status.classList.add('is-error');
    refs.retryButton.hidden = false;
  }

  function summaryText(state) {
    if (state.total === 0) return '';
    const parts = [
      t('js.common.batchSummary', {
        total: state.total,
        images: state.total === 1 ? t('js.common.imageOne') : t('js.common.imageMany'),
      }),
    ];
    if (state.succeeded > 0) parts.push(t('js.common.batchReady', { count: state.succeeded }));
    if (state.failed > 0) parts.push(t('js.common.batchFailed', { count: state.failed }));
    if (state.cancelled > 0) parts.push(t('js.common.batchCancelled', { count: state.cancelled }));
    if (state.queued > 0) parts.push(t('js.common.batchWaitingCount', { count: state.queued }));
    return parts.join(' · ');
  }

  function renderBatch(snapshot = null) {
    const state = snapshot ?? queue?.snapshot() ?? null;
    if (!state) return;

    byIdLatest.clear();
    const seen = new Set();
    for (const item of state.items) {
      byIdLatest.set(item.id, item);
      seen.add(item.id);
      let entry = rows.get(item.id);
      if (!entry) {
        entry = createRow(item);
        rows.set(item.id, entry);
        fileList.append(entry.row);
      }
      updateRow(item, entry);
    }
    for (const [id, entry] of rows) {
      if (!seen.has(id)) {
        entry.row.remove();
        rows.delete(id);
      }
    }

    batchRegion.hidden = state.total === 0;
    /*
     * The row holds a single button that would re-run one image, which is why a desktop hides it for a
     * batch of one. On a phone that same button is the sticky action bar, so hiding its row would leave
     * a visitor who resized a single photo with no action on screen at all.
     */
    const narrow = window.matchMedia(MOBILE_QUERY).matches;
    batchActions.hidden = state.total < (narrow ? 1 : 2);
    batchSummary.textContent = summaryText(state);
    zipButton.hidden = state.total < 2 || state.succeeded === 0;
    if (resizeAllButton) {
      /*
       * On a phone the primary action leaves this row and becomes the fixed bar at the bottom of the
       * viewport, so it is reachable without scrolling past the panel. It appears when there is
       * something to act on and disappears when there is not — the queue's own state, read from the
       * callback the queue already calls. On a desktop the attribute is inert: no rule reads it.
       */
      resizeAllButton.dataset.sticky = state.total > 0 ? 'on' : 'off';
      resizeAllButton.textContent =
        state.total > 0 && state.finished === state.total ? runAgainLabel : runLabel;
    }

    updateProgress(state);
    updateSelection(state);
  }

  function updateProgress(state) {
    if (state.total === 0) {
      progress.hide();
      return;
    }
    if (state.idle) {
      progress.set(
        1,
        state.failed > 0
          ? t('js.common.progressDoneFailed', { succeeded: state.succeeded, total: state.total, failed: state.failed })
          : t('js.common.progressDone', { succeeded: state.succeeded, total: state.total }),
      );
      return;
    }
    if (state.total === 1) {
      progress.set(state.ratio, rows.get(state.items[0].id)?.phaseText || t('js.resize.running'));
      return;
    }
    progress.set(
      state.ratio,
      t('js.common.progressPercent', {
        finished: state.finished,
        total: state.total,
        percent: Math.round(state.ratio * 100),
      }),
    );
  }

  function updateSelection(state) {
    const items = state.items ?? [];
    const selected = selectedId ? items.find((item) => item.id === selectedId) : null;
    if (selected && selected.status === 'done') return;
    const firstDone = items.find((item) => item.status === 'done');
    if (firstDone) {
      selectItem(firstDone.id);
      return;
    }
    if (!selected) clearResult();
  }

  /* ---------- results ---------- */

  function clearPreview() {
    if (previewUrls.before) URL.revokeObjectURL(previewUrls.before);
    if (previewUrls.after) URL.revokeObjectURL(previewUrls.after);
    previewUrls = { before: null, after: null };
    compare.setBefore(null);
    compare.setAfter(null);
    compare.setSavings(Number.NaN, Number.NaN);
  }

  function clearResult() {
    resultPanel.hidden = true;
    clearPreview();
  }

  function nameFor(item) {
    const extension = config.outputExtensions?.[item?.result?.meta?.outputMime] ?? 'img';
    return zipNameFor(item?.file?.name, extension, { suffix: ZIP_SUFFIX });
  }

  function showResult(item) {
    // See compress-image.js: this is the signal the install banner waits for.
    markProcessed();
    const meta = item.result.meta;
    resultPanel.hidden = false;
    clearPreview();
    previewUrls.before = URL.createObjectURL(item.file);
    previewUrls.after = URL.createObjectURL(item.result.blob);
    compare.setBefore(previewUrls.before);
    compare.setAfter(previewUrls.after);
    compare.setSavings(meta.sourceBytes, meta.bytes);

    if (result.dimensions) {
      result.dimensions.textContent = meta.scaled
        ? `${meta.sourceWidth}×${meta.sourceHeight} → ${meta.width}×${meta.height}`
        : `${meta.width}×${meta.height} (unchanged)`;
    }
    if (result.size) result.size.textContent = formatBytes(meta.bytes);
    if (result.scale) {
      const percent = meta.scaled
        ? scalePercent(meta.sourceWidth, meta.sourceHeight, meta.width, meta.height)
        : 0;
      result.scale.textContent = meta.scaled ? `${formatSignedPercent(percent)} of the pixels` : 'No resampling';
    }
    if (result.download) {
      result.download.href = previewUrls.after ?? '';
      result.download.download = nameFor(item);
      result.download.textContent = t('js.common.downloadSize', { size: formatBytes(meta.bytes) });
    }
    // Baked now, while the result is merely being shown: an iOS save tap needs a ready file inside
    // its own activation window, so the Photos-friendly copy must not be encoded on that tap.
    void primePhotosVariant({ blob: item.result.blob, filename: nameFor(item) });
    if (result.warning) {
      const notes = [];
      if (!meta.scaled && !upscaleInput?.checked) {
        notes.push(t('js.resize.upscaleSkipped'));
      }
      if (meta.bytes > meta.sourceBytes) {
        notes.push(
          t('js.common.largerThanOriginalResize', {
            size: formatBytes(meta.bytes - meta.sourceBytes),
          }),
        );
      }
      if (meta.flatten) notes.push(t('js.common.jpegFlatten'));
      const text = notes.join(' ');
      result.warning.hidden = text === '';
      result.warning.textContent = text;
    }
  }

  function selectItem(id) {
    const item = byIdLatest.get(id);
    if (!item || item.status !== 'done' || !item.result) return;
    if (selectedId && selectedId !== id) {
      const previous = rows.get(selectedId);
      if (previous) previous.row.dataset.selected = 'false';
    }
    selectedId = id;
    const entry = rows.get(id);
    if (entry) entry.row.dataset.selected = 'true';
    showResult(item);
  }

  function downloadItem(id) {
    const item = byIdLatest.get(id);
    if (!item?.result?.blob) return;
    const filename = nameFor(item);
    void saveBlob({ blob: item.result.blob, filename, statusEl: statusLine });
  }

  async function downloadAllAsZip() {
    const finished = [...byIdLatest.values()].filter((item) => item.status === 'done' && item.result?.blob);
    if (finished.length === 0) {
      announce(t('js.common.nothingToDownload'), 'error');
      return;
    }

    // iOS Safari cannot save a ZIP at all: an <a download> of one is ignored there. So on iOS the
    // batch leaves through one share sheet — or one swipeable viewer — instead, and only the
    // platforms that can actually save a ZIP go on to build one.
    if (
      await saveBatchOrZip({
        entries: finished.map((item) => ({ blob: item.result.blob, filename: nameFor(item) })),
        statusEl: statusLine,
      })
    ) {
      return;
    }

    zipButton.disabled = true;
    announce(t('js.common.packaging', { count: finished.length }));
    try {
      const entries = [];
      for (const item of finished) entries.push({ name: nameFor(item), bytes: await toBytes(item.result.blob) });
      const size = downloadZip(entries, { filename: ZIP_NAME });
      announce(
        t('js.common.zipReady', {
          count: finished.length,
          images: finished.length === 1 ? t('js.common.imageOne') : t('js.common.imageMany'),
          size: formatBytes(size),
        }),
      );
    } catch (error) {
      announce(error?.message ?? t('js.common.zipFailed'), 'error');
    } finally {
      zipButton.disabled = false;
    }
  }

  /* ---------- batch lifecycle ---------- */

  function disposeQueue() {
    queue?.dispose();
    queue = null;
  }

  function clearRows() {
    for (const entry of rows.values()) entry.row.remove();
    rows.clear();
    byIdLatest.clear();
    reporters.clear();
  }

  function startBatch(files, { autoStart }) {
    if (!ready || busy) return;

    try {
      readOptions();
    } catch (error) {
      announce(error instanceof CompressError ? error.message : 'Those dimensions are not valid.', 'error');
      return;
    }

    disposeQueue();
    clearRows();
    clearResult();
    currentFiles = files.slice();
    selectedId = null;

    queue = createQueue({ concurrency: CONCURRENCY, run: runFile, onUpdate: renderBatch });
    queue.add(currentFiles);
    renderBatch();

    if (!autoStart) {
      announce(t('js.common.batchQueued', { count: currentFiles.length, action: runLabel }));
      return;
    }

    busy = true;
    dropzone.disable();
    announce(
      currentFiles.length === 1
        ? t('js.resize.startingOne', { name: currentFiles[0].name })
        : t('js.resize.startingMany', { count: currentFiles.length }),
    );
    void finishWhenIdle(queue.start());
  }

  async function finishWhenIdle(promise) {
    let state = null;
    try {
      state = await promise;
    } catch {
      state = queue?.snapshot() ?? null;
    }
    busy = false;
    dropzone.enable();
    renderBatch(state);
    announceOutcome(state);
  }

  function announceOutcome(state) {
    if (!state || state.total === 0) return;
    if (state.succeeded === 0 && state.cancelled > 0 && state.failed === 0) {
      announce(t('js.common.cancelled'));
      return;
    }
    const parts = [];
    if (state.succeeded > 0) parts.push(t('js.resize.resizedCount', { count: state.succeeded }));
    if (state.failed > 0) parts.push(t('js.common.batchFailed', { count: state.failed }));
    if (state.cancelled > 0) parts.push(t('js.common.batchCancelled', { count: state.cancelled }));
    announce(
      `${t('js.common.doneParts', { parts: parts.join(', ') })}${state.total > 1 && state.succeeded > 1 ? t('js.compress.zipTail') : ''}`,
    );
  }

  function retryItem(id) {
    if (busy || !queue) return;
    busy = true;
    dropzone.disable();
    announce(t('js.common.retrying'));
    void finishWhenIdle(queue.retry(id));
  }

  function startOver() {
    if (busy) return;
    disposeQueue();
    clearRows();
    clearResult();
    currentFiles = [];
    selectedId = null;
    progress.hide();
    dropzone.reset();
    dropzone.enable();
    batchRegion.hidden = true;
    announce(t('js.common.readyAgain'));
  }

  function applyPreset() {
    const preset = findResizePreset(presetSelect?.value ?? '');
    if (!preset) {
      widthInput.disabled = false;
      heightInput.disabled = false;
      if (presetNote) presetNote.hidden = true;
      return;
    }
    widthInput.value = String(preset.width);
    heightInput.value = String(preset.height);
    widthInput.disabled = true;
    heightInput.disabled = true;
    if (presetNote) {
      const origin = preset.derived
        ? t('js.common.presetOriginDerived')
        : t('js.common.presetOriginPublished');
      presetNote.hidden = false;
      presetNote.textContent = t('js.common.presetNote', {
        label: presetLabel(preset),
        width: preset.width,
        height: preset.height,
        ratio: preset.ratio ?? t('js.common.presetFitsInside'),
        origin,
        note: preset.note,
        source: preset.source,
      });
    }
  }

  async function checkCapabilities() {
    try {
      const report = await ensureWorker().capabilities();
      if (report?.supported) {
        ready = true;
        dropzone.enable();
        announce(t('js.resize.ready'));
        return;
      }
      throw new Error('unsupported');
    } catch {
      if (unsupportedNotice) unsupportedNotice.hidden = false;
      dropzone.disable();
      for (const control of [presetSelect, widthInput, heightInput, formatSelect, lockInput, upscaleInput, resizeAllButton, zipButton]) {
        if (control) control.disabled = true;
      }
      announce(t('js.resize.unsupported'), 'error');
    }
  }

  /* ---------- events ---------- */

  const dropzone = createDropzone(dropzoneRoot, {
    accept: config.accepts ?? [],
    maxBytes: config.maxInputBytes ?? 50 * 1024 * 1024,
    multiple: true,
    onFiles: (files) => startBatch(files, { autoStart: files.length === 1 }),
    onReject: (reason) => announce(reason.message, 'error'),
  });

  cancelButton?.addEventListener('click', () => {
    if (!queue || !busy) return;
    announce(t('js.common.cancelling'));
    queue.cancel();
  });

  resizeAllButton?.addEventListener('click', () => {
    if (currentFiles.length === 0) return;
    startBatch(currentFiles, { autoStart: true });
  });

  zipButton?.addEventListener('click', () => {
    void downloadAllAsZip();
  });

  // The result panel's save control: the anchor keeps its `href` for the no-JavaScript path, and
  // the tap itself goes through the shared save module so it can share or show the viewer instead.
  wireDownloadAnchor(result.download, {
    getBlob: () => byIdLatest.get(selectedId)?.result?.blob ?? null,
    getFilename: () => nameFor(byIdLatest.get(selectedId)),
    statusEl: statusLine,
  });

  resultPanel.querySelector('[data-start-over]')?.addEventListener('click', startOver);
  presetSelect?.addEventListener('change', () => {
    applyPreset();
    if (!busy && ready && currentFiles.length === 1) startBatch(currentFiles, { autoStart: true });
  });

  widthInput.addEventListener('input', () => {
    if (lockInput?.checked) syncAspect('width');
  });
  heightInput.addEventListener('input', () => {
    if (lockInput?.checked) syncAspect('height');
  });

  /**
   * With the ratio locked, editing one box updates the other from the *current* image, so the
   * numbers on screen match what the engine will do. The engine still has the final say (it fits
   * inside the box), which is why this is a convenience rather than the source of truth.
   */
  function syncAspect(axis) {
    const knob = axis === 'width' ? widthInput : heightInput;
    const other = axis === 'width' ? heightInput : widthInput;
    const value = Number(knob.value);
    if (!Number.isFinite(value) || value <= 0) return;

    const track = byIdLatest.values().next().value;
    const meta = track?.result?.meta ?? null;
    if (!meta) return;
    const ratio = axis === 'width' ? meta.sourceHeight / meta.sourceWidth : meta.sourceWidth / meta.sourceHeight;
    other.value = String(Math.max(1, Math.round(value * ratio)));
  }

  for (const element of [lockInput, upscaleInput]) {
    element?.addEventListener('change', () => {
      if (busy || !ready) return;
      if (currentFiles.length === 1) startBatch(currentFiles, { autoStart: true });
    });
  }

  if (upscaleInput) upscaleInput.checked = false;
  if (lockInput) lockInput.checked = true;
  applyPreset();

  /*
   * The breakpoint can be crossed without a page load — a phone rotated, a desktop window dragged
   * narrower — and which side of it we are on decides whether the batch row is hidden.
   */
  window.matchMedia(MOBILE_QUERY).addEventListener('change', () => {
    if (queue) renderBatch();
  });

  window.addEventListener('pagehide', () => {
    disposeQueue();
    clearPreview();
    api?.dispose();
    api = null;
  });

  dropzone.disable();
  announce(t('js.common.checkingBrowser'));
  void checkCapabilities();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
