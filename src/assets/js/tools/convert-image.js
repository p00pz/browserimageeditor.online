/**
 * Convert tool wiring — same shape as tools/compress-image.js:
 * dropzone -> core/queue.js -> convert.worker.js -> compare slider -> core/file-io.js.
 *
 * One difference from the other tools: the format list is built from what this browser proved it
 * can encode, intersected with the formats content/tools.json allows. A format the browser cannot
 * write is simply not offered here, and if that leaves nothing, the tool says so instead of
 * producing files in the wrong format.
 */
import * as Comlink from 'comlink';

import { CompressError } from '../core/engine-compress.js';
import { availableFormats, isHeicFile } from '../core/engine-convert.js';
import { formatLabel } from '../core/formats.js';
import { createQueue } from '../core/queue.js';
import { downloadBlob, downloadZip, toBytes, zipNameFor } from '../core/file-io.js';
import { createCompareSlider } from '../ui/compare-slider.js';
import { createDropzone } from '../ui/dropzone.js';
import { formatBytes, formatSignedPercent } from '../ui/format.js';
import { createProgress } from '../ui/progress.js';
import { markProcessed } from '../ui/pwa.js';
import { localizeError, t } from '../ui/strings.js';

const PHASE_MESSAGES = {
  probe: t('js.convert.phaseProbe'),
  encode: t('js.convert.phaseEncode'),
};

const CONCURRENCY = 2;

/**
 * The width at which the primary action leaves the batch row and becomes a fixed bar at the bottom of
 * the viewport. It has to stay in step with the `max-width: 767px` block in components.css.
 *
 * Every tool script states it once rather than importing it, because a shared module for one string
 * would be a dependency between five files that otherwise share nothing but their worker boundary.
 */
const MOBILE_QUERY = '(max-width: 767px)';

const ZIP_SUFFIX = '-converted';
const ZIP_NAME = 'browserimageeditor-converted.zip';


function readConfig() {
  const element = document.getElementById('tool-config');
  if (!element) throw new Error('convert-image: this page is missing its #tool-config block.');
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
  const encoderNote = root.querySelector('[data-encoder-note]');
  const heicNote = root.querySelector('[data-heic-note]');
  const unsupportedNotice = root.querySelector('[data-unsupported]');
  const batchRegion = root.querySelector('[data-batch]');
  const batchSummary = root.querySelector('[data-batch-summary]');
  const batchActions = root.querySelector('[data-batch-actions]');
  const convertAllButton = root.querySelector('[data-convert-all]');
  /**
   * The run button's two labels travel with the button rather than being looked up in the catalogue.
   * They are written into the markup from `content/ui.json` at build time, so this file never has to
   * know which language it is running in — and there is exactly one place a "Convert all" label is
   * authored instead of a markup copy and a runtime copy that can drift apart.
   */
  const runLabel = convertAllButton?.dataset.label ?? '';
  const runAgainLabel = convertAllButton?.dataset.labelDone ?? runLabel;
  const zipButton = root.querySelector('[data-download-zip]');
  const fileList = root.querySelector('[data-file-list]');
  const progressRegion = root.querySelector('[data-progress-region]');
  const cancelButton = root.querySelector('[data-cancel]');
  const resultPanel = root.querySelector('[data-result]');
  const statusLine = root.querySelector('[data-status]');

  if (!dropzoneRoot || !formatSelect || !progressRegion || !resultPanel || !statusLine || !fileList) {
    throw new Error('convert-image: this page is missing elements the tool needs.');
  }

  const progress = createProgress(progressRegion, { label: t('js.convert.running') });
  const compare = createCompareSlider(root.querySelector('[data-compare]'), {
    savings: root.querySelector('[data-compare-savings]'),
  });

  const result = {
    format: resultPanel.querySelector('[data-result-format]'),
    dimensions: resultPanel.querySelector('[data-result-dimensions]'),
    size: resultPanel.querySelector('[data-result-size]'),
    warning: resultPanel.querySelector('[data-result-warning]'),
    download: resultPanel.querySelector('[data-download]'),
  };

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

  function ensureWorker() {
    if (api) return api;
    worker = new Worker(new URL('../workers/convert.worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('error', () => {
      announce(t('js.convert.workerStopped'), 'error');
    });
    api = Comlink.wrap(worker);
    progressProxy = Comlink.proxy(handleProgress);
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
      return new CompressError(error.code, localizeError(error.code, error.message ?? t('js.convert.failed')));
    }
    return new CompressError(
      'INTERNAL',
      localizeError('INTERNAL', error?.message ?? t('js.convert.failedUnknown')),
    );
  }

  async function runFile(file, { id, signal, report }) {
    if (signal.aborted) throw new CompressError('ABORTED', t('js.common.cancelledBeforeStart'));
    const client = ensureWorker();
    const options = { outputMime: formatSelect.value || config.defaultOutput };
    const forwardAbort = () => {
      void client.cancel(id);
    };
    signal.addEventListener('abort', forwardAbort, { once: true });
    reporters.set(id, report);
    try {
      return await client.convert({ jobId: id, file, options }, progressProxy);
    } catch (error) {
      throw normalizeRejection(error);
    } finally {
      reporters.delete(id);
      signal.removeEventListener('abort', forwardAbort);
    }
  }

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
      refs.status.textContent = entry.phaseText || t('js.convert.running');
      return;
    }
    if (item.status === 'done' && item.result) {
      const meta = item.result.meta;
      refs.meta.textContent = `${formatLabel(meta.outputMime)} · ${formatBytes(meta.sourceBytes)} → ${formatBytes(meta.bytes)}`;
      refs.status.textContent =
        meta.decodeRoute === 'decoder' ? t('js.convert.doneHeic') : t('js.convert.done');
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
     * a visitor who converted a single image with no action on screen at all.
     */
    const narrow = window.matchMedia(MOBILE_QUERY).matches;
    batchActions.hidden = state.total < (narrow ? 1 : 2);
    batchSummary.textContent = summaryText(state);
    zipButton.hidden = state.total < 2 || state.succeeded === 0;
    if (convertAllButton) {
      /*
       * On a phone the primary action leaves this row and becomes the fixed bar at the bottom of the
       * viewport, so it is reachable without scrolling past the panel. It appears when there is
       * something to act on and disappears when there is not — the queue's own state, read from the
       * callback the queue already calls. On a desktop the attribute is inert: no rule reads it.
       */
      convertAllButton.dataset.sticky = state.total > 0 ? 'on' : 'off';
      convertAllButton.textContent =
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
      progress.set(state.ratio, rows.get(state.items[0].id)?.phaseText || t('js.convert.running'));
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

    if (result.format) result.format.textContent = formatLabel(meta.outputMime);
    if (result.dimensions) result.dimensions.textContent = `${meta.width}×${meta.height}`;
    if (result.size) result.size.textContent = formatBytes(meta.bytes);
    if (result.download) {
      result.download.href = previewUrls.after ?? '';
      result.download.download = nameFor(item);
      result.download.textContent = t('js.common.downloadSize', { size: formatBytes(meta.bytes) });
    }
    if (result.warning) {
      const notes = [];
      if (meta.bytes > meta.sourceBytes) {
        const percent = Math.round(((meta.bytes - meta.sourceBytes) / (meta.sourceBytes || 1)) * 1000) / 10;
        notes.push(
          t('js.convert.largerNote', {
            size: formatBytes(meta.bytes - meta.sourceBytes),
            percent: formatSignedPercent(-percent),
          }),
        );
      }
      if (meta.flatten) notes.push(t('js.common.jpegFlatten'));
      if (meta.decodeRoute === 'decoder') notes.push(t('js.convert.decodedByDecoder'));
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
    downloadBlob(item.result.blob, filename);
    announce(t('js.common.savedFile', { name: filename, size: formatBytes(item.result.meta.bytes) }));
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

  function noteHeic(files) {
    if (!heicNote) return;
    // The note's text is in the markup, from the catalogue; this only reveals it. Keeping one copy
    // means the sentence cannot drift between the page and the script.
    heicNote.hidden = !files.some((file) => isHeicFile(file));
  }

  function startBatch(files, { autoStart }) {
    if (!ready || busy) return;
    disposeQueue();
    clearRows();
    clearResult();
    noteHeic(files);
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
        ? t('js.convert.startingOne', { name: currentFiles[0].name })
        : t('js.convert.startingMany', { count: currentFiles.length }),
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
    if (state.succeeded > 0) parts.push(t('js.convert.convertedCount', { count: state.succeeded }));
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
    if (heicNote) heicNote.hidden = true;
    announce(t('js.common.readyAgain'));
  }

  async function checkCapabilities() {
    try {
      const report = await ensureWorker().capabilities();
      if (!report?.supported) throw new Error('unsupported');

      // Only formats this browser proved it can write, and only those content/tools.json allows.
      const allowed = new Set(config.outputs ?? []);
      const usable = availableFormats(report.encodable).filter((mime) => allowed.has(mime));
      if (usable.length === 0) throw new Error('no formats');

      for (const mime of usable) {
        const option = document.createElement('option');
        option.value = mime;
        option.textContent = config.outputLabels?.[mime] ?? formatLabel(mime);
        option.selected = mime === config.defaultOutput || (usable.length === 1 && !option.selected);
        formatSelect.append(option);
      }
      if (!formatSelect.value) formatSelect.value = usable[0];
      // A target page pre-selects its own output format — but only if this browser actually proved
      // it can write it, which is the rule every other option in this list already follows.
      if (defaults.outputMime && usable.includes(defaults.outputMime)) {
        formatSelect.value = defaults.outputMime;
      }

      if (encoderNote) {
        encoderNote.hidden = false;
        const offered = usable.map(formatLabel).join(', ');
        const skipped = (config.outputs ?? []).filter((mime) => !usable.includes(mime)).map(formatLabel);
        encoderNote.textContent = skipped.length
          ? t('js.convert.encoderNoteSkipped', {
              offered,
              skipped: skipped.join(', '),
              formats: skipped.join(t('js.common.listOr')),
            })
          : t('js.convert.encoderNote', { offered });
      }

      ready = true;
      dropzone.enable();
      announce(t('js.convert.ready'));
    } catch {
      if (unsupportedNotice) unsupportedNotice.hidden = false;
      dropzone.disable();
      for (const control of [formatSelect, convertAllButton, zipButton]) {
        if (control) control.disabled = true;
      }
      announce(t('js.convert.unsupported'), 'error');
    }
  }

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

  convertAllButton?.addEventListener('click', () => {
    if (currentFiles.length === 0) return;
    startBatch(currentFiles, { autoStart: true });
  });

  zipButton?.addEventListener('click', () => {
    void downloadAllAsZip();
  });

  resultPanel.querySelector('[data-start-over]')?.addEventListener('click', startOver);

  formatSelect.addEventListener('change', () => {
    if (busy || !ready) return;
    if (currentFiles.length === 1) startBatch(currentFiles, { autoStart: true });
  });

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
    worker?.terminate();
    worker = null;
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
