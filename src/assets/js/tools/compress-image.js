/**
 * Wiring for the compress tool: dropzone -> batch queue -> worker -> compare slider -> download.
 *
 * All image work happens in ../workers/compress.worker.js, which is the only file allowed to
 * touch a browser capability. This file moves messages and paints the result, so the pattern
 * later tools copy is:
 *   ui/ components + core/queue.js + a worker stitched together by tools/<slug>.js.
 *
 * Per-tool metadata (accepted types, output formats and their extensions, size limit) is read
 * from the #tool-config JSON block that scripts/build-pages.mjs injects from content/tools.json.
 *
 * Two behaviours worth knowing:
 *   - one image auto-runs on drop (so "drop a file, type 100 KB" needs no extra click), with
 *     options re-running it on change;
 *   - a batch of two or more waits for the explicit "Compress all" button, because a stray
 *     settings tweak must not silently restart fifty jobs.
 */
import * as Comlink from 'comlink';

import { CompressError, estimateSavings, parseDimension, parseTargetBytes } from '../core/engine-compress.js';
import { createQueue } from '../core/queue.js';
import {
  DEFAULT_ZIP_NAME,
  ZIP_SIZE_WARNING_BYTES,
  downloadBlob,
  downloadZip,
  toBytes,
  totalBytes,
  zipNameFor,
} from '../core/file-io.js';
import { createCompareSlider } from '../ui/compare-slider.js';
import { createDropzone } from '../ui/dropzone.js';
import { formatBytes, formatSignedPercent } from '../ui/format.js';
import { createProgress } from '../ui/progress.js';
import { markProcessed } from '../ui/pwa.js';
import { localizeError, t } from '../ui/strings.js';

const PHASE_MESSAGES = {
  probe: t('js.compress.phaseProbe'),
  fit: t('js.compress.phaseFit'),
  search: t('js.compress.phaseSearch'),
  encode: t('js.compress.phaseEncode'),
};

/** Two at a time: a memory bound, not a tuning knob (see core/queue.js). */
const CONCURRENCY = 2;

/**
 * The width at which the primary action leaves the batch row and becomes a fixed bar at the bottom of
 * the viewport. It has to stay in step with the `max-width: 767px` block in components.css.
 *
 * Every tool script states it once rather than importing it, because a shared module for one string
 * would be a dependency between five files that otherwise share nothing but their worker boundary.
 */
const MOBILE_QUERY = '(max-width: 767px)';

function readConfig() {
  const element = document.getElementById('tool-config');
  if (!element) throw new Error('compress-image: this page is missing its #tool-config block.');
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
  const formatSelect = root.querySelector('[data-output-format]');
  const targetInput = root.querySelector('[data-target-size]');
  const widthInput = root.querySelector('[data-max-width]');
  const heightInput = root.querySelector('[data-max-height]');
  const unsupportedNotice = root.querySelector('[data-unsupported]');
  const batchRegion = root.querySelector('[data-batch]');
  const batchSummary = root.querySelector('[data-batch-summary]');
  const batchActions = root.querySelector('[data-batch-actions]');
  const compressAllButton = root.querySelector('[data-compress-all]');
  /**
   * The run button's two labels travel with the button rather than being looked up in the catalogue.
   *
   * They are written into the markup from `content/ui.json` at build time, so this file never has to
   * know which language it is running in — and there is exactly one place a "Compress all" label is
   * authored instead of a markup copy and a runtime copy that can drift apart.
   */
  const runLabel = compressAllButton?.dataset.label ?? '';
  const runAgainLabel = compressAllButton?.dataset.labelDone ?? runLabel;
  const zipButton = root.querySelector('[data-download-zip]');
  const fileList = root.querySelector('[data-file-list]');
  const progressRegion = root.querySelector('[data-progress-region]');
  const cancelButton = root.querySelector('[data-cancel]');
  const resultPanel = root.querySelector('[data-result]');
  const statusLine = root.querySelector('[data-status]');

  if (!dropzoneRoot || !formatSelect || !progressRegion || !resultPanel || !statusLine || !fileList) {
    throw new Error('compress-image: this page is missing elements the tool needs.');
  }

  const progress = createProgress(progressRegion, { label: t('js.compress.running') });
  const compare = createCompareSlider(root.querySelector('[data-compare]'), {
    savings: root.querySelector('[data-compare-savings]'),
  });

  const result = {
    saved: resultPanel.querySelector('[data-result-saved]'),
    dimensions: resultPanel.querySelector('[data-result-dimensions]'),
    quality: resultPanel.querySelector('[data-result-quality]'),
    warning: resultPanel.querySelector('[data-result-warning]'),
    download: resultPanel.querySelector('[data-download]'),
  };

  for (const mime of config.outputs ?? []) {
    const option = document.createElement('option');
    option.value = mime;
    option.textContent = config.outputLabels?.[mime] ?? mime;
    option.selected = mime === config.defaultOutput;
    formatSelect.append(option);
  }

  if (Number.isInteger(defaults.targetSizeKB)) {
    targetInput.value = String(defaults.targetSizeKB);
  }

  /** item id -> { row, refs, phaseText } */
  const rows = new Map();
  /** item id -> the queue's report() for the file currently running under that id */
  const reporters = new Map();
  /** item id -> the latest snapshot copy of that item */
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

  function ensureWorker() {
    if (api) return api;
    worker = new Worker(new URL('../workers/compress.worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('error', () => {
      announce(t('js.compress.workerStopped'), 'error');
    });
    api = Comlink.wrap(worker);
    // One proxied callback for the whole page, dispatched by job id, rather than a new proxy
    // per file — those would have to be released one by one to avoid leaking. It must be passed
    // as a separate top-level argument: comlink only wires top-level arguments, so nesting it in
    // the payload object would attempt to clone a function and fail.
    progressProxy = Comlink.proxy(handleProgress);
    return api;
  }

  function handleProgress(update) {
    if (!update || !update.jobId) return;
    const entry = rows.get(update.jobId);
    if (entry) {
      entry.phaseText =
        update.phase === 'search' && Number.isFinite(update.quality)
          ? t('js.compress.tryingQuality', { percent: Math.round(update.quality * 100) })
          : PHASE_MESSAGES[update.phase] ?? entry.phaseText;
    }
    reporters.get(update.jobId)?.(update.ratio ?? 0);
  }

  /** comlink rejects with the plain object the worker threw; one error type on this side. */
  function normalizeRejection(error) {
    if (error && typeof error === 'object' && typeof error.code === 'string') {
      return new CompressError(error.code, localizeError(error.code, error.message ?? t('js.compress.failed')));
    }
    return new CompressError(
      'INTERNAL',
      localizeError('INTERNAL', error?.message ?? t('js.compress.failedUnknown')),
    );
  }

  function readOptions() {
    return {
      outputMime: formatSelect.value || config.defaultOutput,
      targetBytes: parseTargetBytes(targetInput?.value),
      maxWidth: parseDimension(widthInput?.value),
      maxHeight: parseDimension(heightInput?.value),
    };
  }

  /** The queue's per-file unit of work. */
  async function runFile(file, { id, signal, report }) {
    if (signal.aborted) throw new CompressError('ABORTED', t('js.common.cancelledBeforeStart'));

    const client = ensureWorker();
    const options = readOptions();

    // Cancelling has to reach the worker, where the AbortController lives, so that the
    // encoder stops mid-flight instead of finishing a file nobody wants.
    const forwardAbort = () => {
      void client.cancel(id);
    };
    signal.addEventListener('abort', forwardAbort, { once: true });
    reporters.set(id, report);

    try {
      return await client.compress({ jobId: id, file, options }, progressProxy);
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

  /** Builds a row once. Everything from a file name to an error message goes in as text, never HTML. */
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
    return {
      row,
      refs: { meta, status, track, bar, compareButton, downloadButton, retryButton },
      phaseText: '',
    };
  }

  function outcomeNote(meta) {
    if (meta.status === 'near') {
      return t('js.compress.nearTarget', {
        over: formatBytes(meta.overByBytes),
        target: formatBytes(meta.targetBytes),
      });
    }
    if (meta.status === 'unreachable') {
      return t('js.compress.unreachableTarget', {
        target: formatBytes(meta.targetBytes),
        smallest: formatBytes(meta.bytes),
      });
    }
    return '';
  }

  function nameFor(item) {
    const extension = config.outputExtensions?.[item?.result?.meta?.outputMime] ?? 'img';
    return zipNameFor(item?.file?.name, extension);
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
      refs.status.textContent = entry.phaseText || t('js.compress.running');
      return;
    }

    if (item.status === 'done' && item.result) {
      const meta = item.result.meta;
      const savings = estimateSavings(meta.sourceBytes, meta.bytes);
      refs.meta.textContent = `${sourceSize} → ${formatBytes(meta.bytes)} (${formatSignedPercent(savings.percent)})`;
      refs.status.textContent =
        outcomeNote(meta) || t('js.compress.doneAt', { percent: Math.round(meta.quality * 100) });
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
     * The batch row holds a single button that would re-run one image, which is why a desktop hides it
     * for a batch of one. On a phone that same button is the sticky action bar, so hiding its row would
     * leave a visitor who compressed a single photo with no action on screen at all.
     */
    const narrow = window.matchMedia(MOBILE_QUERY).matches;
    batchActions.hidden = state.total < (narrow ? 1 : 2);
    batchSummary.textContent = summaryText(state);
    zipButton.hidden = state.total < 2 || state.succeeded === 0;

    /*
     * On a phone the primary action leaves this row and becomes a fixed bar at the bottom of the
     * viewport, so it is reachable without scrolling past the panel. It appears when there is
     * something to act on and disappears when there is not — which is the queue's own state, read
     * from the callback the queue already calls, rather than a second source of truth. On a desktop
     * the attribute is inert: no rule reads it.
     */
    compressAllButton.dataset.sticky = state.total > 0 ? 'on' : 'off';
    compressAllButton.textContent =
      state.total > 0 && state.finished === state.total ? runAgainLabel : runLabel;

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
      progress.set(state.ratio, rows.get(state.items[0].id)?.phaseText || t('js.compress.running'));
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

  function showResult(item) {
    // The install banner waits for this: a visitor who has already compressed something is the only
    // audience it is meant for, and it is the one thing this tool knows that the banner needs.
    markProcessed();
    const meta = item.result.meta;
    const savings = estimateSavings(meta.sourceBytes, meta.bytes);

    resultPanel.hidden = false;
    clearPreview();
    previewUrls.before = URL.createObjectURL(item.file);
    previewUrls.after = URL.createObjectURL(item.result.blob);
    compare.setBefore(previewUrls.before);
    compare.setAfter(previewUrls.after);
    compare.setSavings(meta.sourceBytes, meta.bytes);

    if (result.saved) {
      result.saved.textContent = `${formatSignedPercent(savings.percent)} (${formatBytes(Math.abs(savings.bytes))})`;
    }
    if (result.dimensions) {
      result.dimensions.textContent = meta.scaled
        ? `${meta.sourceWidth}×${meta.sourceHeight} → ${meta.width}×${meta.height}`
        : `${meta.width}×${meta.height}`;
    }
    if (result.quality) {
      result.quality.textContent = Number.isFinite(meta.quality) ? `${Math.round(meta.quality * 100)}%` : '—';
    }
    if (result.download) {
      result.download.href = previewUrls.after ?? '';
      result.download.download = nameFor(item);
      result.download.textContent = t('js.common.downloadSize', { size: formatBytes(meta.bytes) });
    }
    if (result.warning) {
      const notes = [outcomeNote(meta)];
      if (savings.percent < 0) {
        notes.push(t('js.common.largerThanOriginal', { size: formatBytes(Math.abs(savings.bytes)) }));
      }
      if (meta.flatten) {
        notes.push(t('js.common.jpegFlatten'));
      }
      const text = notes.filter(Boolean).join(' ');
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
    downloadBlob(item.result.blob, filename);
    announce(
      t('js.common.savedFile', { name: filename, size: formatBytes(item.result.meta.bytes) }),
    );
  }

  async function downloadAllAsZip() {
    const finished = [...byIdLatest.values()].filter((item) => item.status === 'done' && item.result?.blob);
    if (finished.length === 0) {
      announce(t('js.common.nothingToDownload'), 'error');
      return;
    }

    zipButton.disabled = true;
    announce(t('js.common.packaging', { count: finished.length }));
    try {
      const entries = [];
      for (const item of finished) {
        entries.push({ name: nameFor(item), bytes: await toBytes(item.result.blob) });
      }
      const bytes = totalBytes(entries);
      const size = downloadZip(entries, { filename: DEFAULT_ZIP_NAME });
      announce(
        bytes > ZIP_SIZE_WARNING_BYTES
          ? t('js.common.zipReadyLarge', { size: formatBytes(size) })
          : t('js.common.zipReady', {
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

    // Options are re-read per file inside runFile; this call exists so a nonsense target or
    // dimension fails once, up front, instead of failing once per file in the batch.
    try {
      readOptions();
    } catch (error) {
      announce(
        error instanceof CompressError ? error.message : t('js.compress.invalidSettings'),
        'error',
      );
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
      announce(
        t('js.common.batchQueued', { count: currentFiles.length, action: runLabel }),
      );
      return;
    }

    busy = true;
    dropzone.disable();
    announce(
      currentFiles.length === 1
        ? t('js.compress.startingOne', { name: currentFiles[0].name })
        : t('js.compress.startingMany', { count: currentFiles.length }),
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
    if (state.succeeded > 0) parts.push(t('js.compress.compressedCount', { count: state.succeeded }));
    if (state.failed > 0) parts.push(t('js.common.batchFailed', { count: state.failed }));
    if (state.cancelled > 0) parts.push(t('js.common.batchCancelled', { count: state.cancelled }));
    const tail = state.total > 1 && state.succeeded > 1 ? t('js.compress.zipTail') : '';
    announce(`${t('js.common.doneParts', { parts: parts.join(', ') })}${tail}`);
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

  async function checkCapabilities() {
    try {
      const report = await ensureWorker().capabilities();
      if (report?.supported) {
        ready = true;
        dropzone.enable();
        announce(t('js.compress.ready'));
        return;
      }
      throw new Error('unsupported');
    } catch {
      if (unsupportedNotice) unsupportedNotice.hidden = false;
      dropzone.disable();
      for (const control of [formatSelect, targetInput, widthInput, heightInput, compressAllButton, zipButton]) {
        if (control) control.disabled = true;
      }        announce(t('js.compress.unsupported'), 'error');
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

  compressAllButton?.addEventListener('click', () => {
    if (currentFiles.length === 0) return;
    startBatch(currentFiles, { autoStart: true });
  });

  zipButton?.addEventListener('click', () => {
    void downloadAllAsZip();
  });

  resultPanel.querySelector('[data-start-over]')?.addEventListener('click', startOver);

  for (const element of [formatSelect, targetInput, widthInput, heightInput]) {
    element?.addEventListener('change', () => {
      if (busy || !ready) return;
      if (currentFiles.length === 1) startBatch(currentFiles, { autoStart: true });
    });
  }

  /*
   * The breakpoint above can be crossed without a page load — a phone rotated, a desktop window
   * dragged narrower — and which side of it we are on decides whether the row is hidden.
   */
  window.matchMedia(MOBILE_QUERY).addEventListener('change', () => {
    if (queue) renderBatch();
  });

  window.addEventListener('pagehide', () => {
    disposeQueue();
    clearPreview();
    worker?.terminate();
    worker = null;
    api = null;
  });

  // Until the worker answers, the dropzone stays disabled: better a moment of "checking" than
  // a drop that fails.
  dropzone.disable();
  announce(t('js.common.checkingBrowser'));
  void checkCapabilities();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
