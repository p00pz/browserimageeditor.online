/**
 * Enhance tool wiring — same shape as tools/convert-image.js:
 * dropzone -> core/queue.js -> enhance.worker.js -> compare slider -> core/file-io.js.
 *
 * Three things this tool does that the others do not:
 *
 *   - **It renders the preset row from the visitor's own photo.** The five thumbnails arrive from the
 *     worker's `previews()` call, which decodes the first queued file once at 160px and grades it five
 *     times. A preset chip is only clickable once its thumbnail exists, so nobody picks a style they
 *     have not seen applied to their own image.
 *   - **One photo drives the row, the whole batch gets the choice.** A batch of ten photos shares one
 *     preset and one intensity, because that is what a batch is for; the thumbnails come from whichever
 *     file was dropped first, which is the one the visitor is looking at.
 *   - **Nothing re-runs on its own while a batch is on screen.** With a single image, moving the slider
 *     or picking a preset re-runs it after a short debounce (so dragging the slider does not spawn a job
 *     per pixel). With a batch, the controls only set the value and the primary action applies it.
 */
import { CompressError } from '../core/engine-compress.js';
import { openEngine } from '../core/worker-or-main.js';
import {
  AUTO_PRESET_ID,
  DEFAULT_PRESET_ID,
  ENHANCE_PRESETS,
  NEUTRAL_ADVANCED,
  isNeutralAdvanced,
} from '../core/engine-enhance.js';
import { createQueue } from '../core/queue.js';
import { downloadZip, toBytes, zipNameFor } from '../core/file-io.js';
import { primePhotosVariant, saveBatchOrZip, saveBlob, wireDownloadAnchor } from '../core/save-photo.js';
import { createCompareSlider } from '../ui/compare-slider.js';
import { createDropzone } from '../ui/dropzone.js';
import { formatBytes } from '../ui/format.js';
import { createProgress } from '../ui/progress.js';
import { markProcessed } from '../ui/pwa.js';
import { localizeError, t } from '../ui/strings.js';

const PHASE_MESSAGES = {
  probe: t('js.enhance.phaseProbe'),
  analyse: t('js.enhance.phaseAnalyse'),
  grade: t('js.enhance.phaseGrade'),
  encode: t('js.enhance.phaseEncode'),
};

const CONCURRENCY = 2;

/**
 * The width at which the primary action leaves the batch row and becomes a fixed bar at the bottom of
 * the viewport. It has to stay in step with the `max-width: 767px` block in components.css.
 *
 * Every tool script states it once rather than importing it, because a shared module for one string
 * would be a dependency between six files that otherwise share nothing but their worker boundary.
 */
const MOBILE_QUERY = '(max-width: 767px)';

/** Dragging a slider fires an input event per pixel; this is how long the value has to settle first. */
const LIVE_RERUN_DELAY_MS = 260;

/** The preview job's id. It is cancelled and restarted whenever a new file selection arrives. */
const PREVIEW_JOB_ID = 'preset-previews';

const ZIP_SUFFIX = '-enhanced';
const ZIP_NAME = 'browserimageeditor-enhanced.zip';

function readConfig() {
  const element = document.getElementById('tool-config');
  if (!element) throw new Error('enhance-photo: this page is missing its #tool-config block.');
  return JSON.parse(element.textContent);
}

function init() {
  const root = document.querySelector('[data-tool-root]');
  if (!root) return;

  const config = readConfig();
  // A target landing page (/targets/<slug>/) ships this panel pre-configured, and tool pages send no
  // "defaults" key at all. Filling a control is all this does: it must never start a run, since nothing
  // has been dropped yet.
  const defaults = config.defaults ?? {};
  const dropzoneRoot = root.querySelector('[data-dropzone]');
  const unsupportedNotice = root.querySelector('[data-unsupported]');
  const presetRow = root.querySelector('[data-preset-row]');
  const previewStatus = root.querySelector('[data-preview-status]');
  const autoButton = root.querySelector('[data-auto-enhance]');
  const intensityInput = root.querySelector('[data-intensity]');
  const intensityOutput = root.querySelector('[data-intensity-output]');
  const intensityField = root.querySelector('[data-intensity-field]');
  const advancedPanel = root.querySelector('[data-advanced]');
  const advancedInputs = {
    brightness: root.querySelector('[data-advanced-brightness]'),
    contrast: root.querySelector('[data-advanced-contrast]'),
    warmth: root.querySelector('[data-advanced-warmth]'),
  };
  const advancedOutputs = {
    brightness: root.querySelector('[data-advanced-brightness-output]'),
    contrast: root.querySelector('[data-advanced-contrast-output]'),
    warmth: root.querySelector('[data-advanced-warmth-output]'),
  };
  const advancedReset = root.querySelector('[data-advanced-reset]');
  const batchRegion = root.querySelector('[data-batch]');
  const batchSummary = root.querySelector('[data-batch-summary]');
  const batchActions = root.querySelector('[data-batch-actions]');
  const enhanceAllButton = root.querySelector('[data-enhance-all]');
  /**
   * The run button's two labels travel with the button rather than being looked up in the catalogue.
   * They are written into the markup from `content/ui.json` at build time, so this file never has to
   * know which language it is running in — and there is exactly one place a "Enhance all" label is
   * authored instead of a markup copy and a runtime copy that can drift apart.
   */
  const runLabel = enhanceAllButton?.dataset.label ?? '';
  const runAgainLabel = enhanceAllButton?.dataset.labelDone ?? runLabel;
  const zipButton = root.querySelector('[data-download-zip]');
  const fileList = root.querySelector('[data-file-list]');
  const progressRegion = root.querySelector('[data-progress-region]');
  const cancelButton = root.querySelector('[data-cancel]');
  const resultPanel = root.querySelector('[data-result]');
  const statusLine = root.querySelector('[data-status]');

  if (
    !dropzoneRoot ||
    !presetRow ||
    !intensityInput ||
    !progressRegion ||
    !resultPanel ||
    !statusLine ||
    !fileList
  ) {
    throw new Error('enhance-photo: this page is missing elements the tool needs.');
  }

  const progress = createProgress(progressRegion, { label: t('js.enhance.running') });
  const compare = createCompareSlider(root.querySelector('[data-compare]'), {
    savings: root.querySelector('[data-compare-savings]'),
  });

  const result = {
    preset: resultPanel.querySelector('[data-result-preset]'),
    intensity: resultPanel.querySelector('[data-result-intensity]'),
    dimensions: resultPanel.querySelector('[data-result-dimensions]'),
    size: resultPanel.querySelector('[data-result-size]'),
    correction: root.querySelector('[data-correction]'),
    warning: resultPanel.querySelector('[data-result-warning]'),
    download: resultPanel.querySelector('[data-download]'),
  };

  /**
   * The chips, in the catalogue's own order. `ENHANCE_PRESETS` owns the ids and the numbers; the markup
   * owns the labels (from `content/ui.json`), so neither a preset id nor a translated name is written
   * down twice.
   */
  const chips = new Map();
  for (const chip of presetRow.querySelectorAll('[data-preset-chip]')) {
    chips.set(chip.dataset.preset, chip);
  }
  const autoLabel = autoButton?.dataset.label ?? '';

  const rows = new Map();
  const reporters = new Map();
  const byIdLatest = new Map();
  const previewUrls = [];

  let worker = null;
  let api = null;
  let progressProxy = null;
  let previewProgressProxy = null;
  let queue = null;
  let currentFiles = [];
  let selectedId = null;
  let resultUrls = { before: null, after: null };
  let busy = false;
  let ready = false;
  let presetId = defaults.presetId ?? DEFAULT_PRESET_ID;
  let intensity = defaults.intensity ?? 1;
  let advanced = { ...NEUTRAL_ADVANCED };
  let rerunTimer = null;

  function announce(message, tone = 'info') {
    statusLine.textContent = message;
    statusLine.classList.toggle('is-error', tone === 'error');
  }

  function announcePreview(message, tone = 'info') {
    if (!previewStatus) return;
    previewStatus.textContent = message;
    previewStatus.classList.toggle('is-error', tone === 'error');
  }

  function ensureWorker() {
    if (api) return api;
    // See compress-image.js: the worker is constructed here so the bundler can resolve it.
    worker = new Worker(new URL('../workers/enhance.worker.js', import.meta.url), { type: 'module' });
    api = openEngine('enhance', worker, {
      onError: () => announce(t('js.enhance.workerStopped'), 'error'),
    });
    // Plain functions here, proxied by the engine only when a call is forwarded to a worker. Two
    // callbacks, because the preview row and the batch report to different status lines.
    progressProxy = handleProgress;
    previewProgressProxy = handlePreviewProgress;
    return api;
  }

  function handleProgress(update) {
    if (!update || !update.jobId) return;
    const entry = rows.get(update.jobId);
    if (entry) entry.phaseText = PHASE_MESSAGES[update.phase] ?? entry.phaseText;
    reporters.get(update.jobId)?.(update.ratio ?? 0);
  }

  function handlePreviewProgress(update) {
    if (!update || update.jobId !== PREVIEW_JOB_ID) return;
    if (update.phase === 'previews') {
      announcePreview(t('js.enhance.previewsProgress', { percent: Math.round((update.ratio ?? 0) * 100) }));
    }
  }

  function normalizeRejection(error) {
    if (error && typeof error === 'object' && typeof error.code === 'string') {
      return new CompressError(error.code, localizeError(error.code, error.message ?? t('js.enhance.failed')));
    }
    return new CompressError('INTERNAL', localizeError('INTERNAL', error?.message ?? t('js.enhance.failedUnknown')));
  }

  async function runFile(file, { id, signal, report }) {
    if (signal.aborted) throw new CompressError('ABORTED', t('js.common.cancelledBeforeStart'));
    const client = ensureWorker();
    const options = {
      presetId,
      intensity,
      advanced: isNeutralAdvanced(advanced) ? null : { ...advanced },
    };
    const forwardAbort = () => {
      void client.cancel(id);
    };
    signal.addEventListener('abort', forwardAbort, { once: true });
    reporters.set(id, report);
    try {
      return await client.enhance({ jobId: id, file, options }, progressProxy);
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
      refs.status.textContent = entry.phaseText || t('js.enhance.running');
      return;
    }
    if (item.status === 'done' && item.result) {
      const meta = item.result.meta;
      refs.meta.textContent = `${labelForPreset(meta.presetId)} · ${formatBytes(meta.sourceBytes)} → ${formatBytes(meta.bytes)}`;
      refs.status.textContent = meta.styled
        ? t('js.enhance.doneStyled', { preset: labelForPreset(meta.presetId) })
        : t('js.enhance.doneAuto');
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

  function labelForPreset(id) {
    if (id === AUTO_PRESET_ID) return autoLabel;
    return chips.get(id)?.dataset.label ?? id;
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
     * a visitor who enhanced a single image with no action on screen at all.
     */
    const narrow = window.matchMedia(MOBILE_QUERY).matches;
    batchActions.hidden = state.total < (narrow ? 1 : 2);
    batchSummary.textContent = summaryText(state);
    zipButton.hidden = state.total < 2 || state.succeeded === 0;
    if (enhanceAllButton) {
      /*
       * On a phone the primary action leaves this row and becomes the fixed bar at the bottom of the
       * viewport, so it is reachable without scrolling past the panel. It appears when there is
       * something to act on and disappears when there is not — the queue's own state, read from the
       * callback the queue already calls. On a desktop the attribute is inert: no rule reads it.
       */
      enhanceAllButton.dataset.sticky = state.total > 0 ? 'on' : 'off';
      enhanceAllButton.textContent =
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
      progress.set(state.ratio, rows.get(state.items[0].id)?.phaseText || t('js.enhance.running'));
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
    if (resultUrls.before) URL.revokeObjectURL(resultUrls.before);
    if (resultUrls.after) URL.revokeObjectURL(resultUrls.after);
    resultUrls = { before: null, after: null };
    compare.setBefore(null);
    compare.setAfter(null);
    compare.setSavings(Number.NaN, Number.NaN);
  }

  function clearResult() {
    resultPanel.hidden = true;
    if (result.correction) result.correction.textContent = '';
    clearPreview();
  }

  function clearPreviewThumbnails() {
    for (const url of previewUrls) URL.revokeObjectURL(url);
    previewUrls.length = 0;
    for (const chip of chips.values()) {
      const image = chip.querySelector('[data-preset-thumb]');
      if (image) {
        image.removeAttribute('src');
        image.alt = '';
      }
      chip.disabled = true;
      chip.dataset.state = 'pending';
    }
    presetRow.dataset.state = 'loading';
  }

  function nameFor(item) {
    const extension = config.outputExtensions?.[item?.result?.meta?.outputMime] ?? 'img';
    return zipNameFor(item?.file?.name, extension, { suffix: ZIP_SUFFIX });
  }

  /**
   * The two numbers the correction actually moved, in the order the engine reports them: red, green,
   * blue. A reader who does not care about channels still learns whether the photo needed the work.
   */
  function correctionText(correction) {
    if (!correction) return '';
    if (!correction.applied) return t('js.enhance.correctionSkipped');
    const gains = correction.gains.map((gain) => `${gain.toFixed(2)}×`).join(' / ');
    const black = correction.blackPoint.join(' / ');
    const white = correction.whitePoint.join(' / ');
    return t('js.enhance.correctionApplied', { gains, black, white });
  }

  function showResult(item) {
    // See compress-image.js: this is the signal the install banner waits for.
    markProcessed();
    const meta = item.result.meta;
    resultPanel.hidden = false;
    clearPreview();
    resultUrls.before = URL.createObjectURL(item.file);
    resultUrls.after = URL.createObjectURL(item.result.blob);
    compare.setBefore(resultUrls.before);
    compare.setAfter(resultUrls.after);
    compare.setSavings(meta.sourceBytes, meta.bytes);

    if (result.preset) result.preset.textContent = labelForPreset(meta.presetId);
    if (result.intensity) {
      result.intensity.textContent = meta.styled ? `${Math.round(meta.intensity * 100)}%` : '—';
    }
    if (result.dimensions) result.dimensions.textContent = `${meta.width}×${meta.height}`;
    if (result.size) result.size.textContent = formatBytes(meta.bytes);
    if (result.correction) result.correction.textContent = correctionText(meta.correction);
    if (result.download) {
      result.download.href = resultUrls.after ?? '';
      result.download.download = nameFor(item);
      result.download.textContent = t('js.common.downloadSize', { size: formatBytes(meta.bytes) });
    }
    // Baked now, while the result is merely being shown: an iOS save tap needs a ready file inside
    // its own activation window, so the Photos-friendly copy must not be encoded on that tap.
    void primePhotosVariant({ blob: item.result.blob, filename: nameFor(item) });
    if (result.warning) {
      const notes = [];
      if (meta.bytes > meta.sourceBytes) {
        const percent = Math.round(((meta.bytes - meta.sourceBytes) / (meta.sourceBytes || 1)) * 1000) / 10;
        notes.push(t('js.enhance.largerNote', { size: formatBytes(meta.bytes - meta.sourceBytes), percent }));
      }
      if (meta.gradePath === 'manual' && meta.styled) notes.push(t('js.enhance.manualPath'));
      if (meta.outputFallback) notes.push(t('js.enhance.formatFallback'));
      if (!meta.styled && meta.intensity === 0) notes.push(t('js.enhance.zeroIntensity'));
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

  /* ---------- the controls ---------- */

  function renderControls() {
    for (const [id, chip] of chips) {
      const isSelected = presetId === id;
      chip.dataset.selected = isSelected ? 'true' : 'false';
      chip.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    }
    if (autoButton) {
      const isAuto = presetId === AUTO_PRESET_ID;
      autoButton.dataset.selected = isAuto ? 'true' : 'false';
      autoButton.setAttribute('aria-pressed', isAuto ? 'true' : 'false');
    }
    intensityInput.value = String(Math.round(intensity * 100));
    if (intensityOutput) intensityOutput.textContent = `${Math.round(intensity * 100)}%`;
    /*
     * With Auto selected there is no Stage B to blend towards, so the intensity slider is disabled
     * rather than left there doing nothing: `data-disabled` is what the CSS dims, and `disabled` is what
     * stops a keyboard user tabbing into a control that cannot change the result.
     */
    const autoOnly = presetId === AUTO_PRESET_ID;
    intensityInput.disabled = autoOnly;
    if (intensityField) intensityField.dataset.disabled = autoOnly ? 'true' : 'false';

    if (!advancedPanel) return;
    const values = { brightness: advanced.brightness, contrast: advanced.contrast, warmth: advanced.warmth };
    for (const key of ['brightness', 'contrast', 'warmth']) {
      const input = advancedInputs[key];
      if (input) input.value = String(Math.round(values[key] * 100));
      const output = advancedOutputs[key];
      if (!output) continue;
      output.textContent =
        key === 'warmth'
          ? `${values[key] > 0 ? '+' : ''}${Math.round(values[key] * 100)}`
          : `${Math.round(values[key] * 100)}%`;
    }
    const neutral = isNeutralAdvanced(advanced);
    if (advancedReset) advancedReset.disabled = neutral;
    advancedPanel.dataset.modified = neutral ? 'false' : 'true';
  }

  function setPreset(id, { rerun = true } = {}) {
    presetId = id;
    renderControls();
    if (rerun) scheduleLiveRerun();
  }

  /**
   * Re-runs a single-image result shortly after the last control change.
   *
   * Only for a single file, and only while nothing else is running: a batch is applied by pressing the
   * primary action, because re-running ten photos on every slider pixel would be a queue of its own.
   */
  function scheduleLiveRerun() {
    if (!ready || busy || currentFiles.length !== 1) return;
    if (rerunTimer) clearTimeout(rerunTimer);
    rerunTimer = setTimeout(() => {
      rerunTimer = null;
      if (!busy && currentFiles.length === 1) startBatch(currentFiles, { autoStart: true, keepPreviews: true });
    }, LIVE_RERUN_DELAY_MS);
  }

  /**
   * The five thumbnails, from the visitor's own photo.
   *
   * A new selection cancels the previous preview job and revokes the previous URLs before starting, so
   * dropping a second photo cannot leave the first one's thumbnails on screen — or leak its object URLs.
   */
  async function loadPreviews(file) {
    if (!file) return;
    const client = ensureWorker();
    void client.cancel(PREVIEW_JOB_ID).catch(() => {});
    clearPreviewThumbnails();
    announcePreview(t('js.enhance.previewsLoading'));

    try {
      const report = await client.previews(
        { jobId: PREVIEW_JOB_ID, file, options: {} },
        previewProgressProxy,
      );
      for (const preset of ENHANCE_PRESETS) {
        const chip = chips.get(preset.id);
        const item = report.items?.find((entry) => entry.presetId === preset.id);
        if (!chip || !item?.blob) continue;
        const url = URL.createObjectURL(item.blob);
        previewUrls.push(url);
        const image = chip.querySelector('[data-preset-thumb]');
        if (image) {
          image.src = url;
          image.alt = t('js.enhance.thumbAlt', { preset: chip.dataset.label ?? preset.id });
        }
        chip.disabled = false;
        chip.dataset.state = 'ready';
      }
      presetRow.dataset.state = 'ready';
      announcePreview(t('js.enhance.previewsReady'));
    } catch (error) {
      // A cancelled preview job is the normal outcome of a newer selection — not something to report.
      if (error?.code === 'ABORTED') return;
      presetRow.dataset.state = 'error';
      /*
       * The chips are enabled anyway. A thumbnail is a convenience, not a precondition: a visitor whose
       * browser could not render the previews can still choose a style by name and see the result on the
       * full-size image, which is the thing they actually came for.
       */
      for (const chip of chips.values()) {
        chip.disabled = false;
        chip.dataset.state = 'unavailable';
      }
      announcePreview(t('js.enhance.previewsFailed'), 'error');
    }
  }

  function startBatch(files, { autoStart, keepPreviews = false }) {
    if (!ready || busy) return;
    disposeQueue();
    clearRows();
    clearResult();
    currentFiles = files.slice();
    selectedId = null;

    if (!keepPreviews) void loadPreviews(currentFiles[0]);

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
        ? t('js.enhance.startingOne', { name: currentFiles[0].name })
        : t('js.enhance.startingMany', { count: currentFiles.length }),
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
    if (state.succeeded > 0) parts.push(t('js.enhance.enhancedCount', { count: state.succeeded }));
    if (state.failed > 0) parts.push(t('js.common.batchFailed', { count: state.failed }).toLowerCase());
    if (state.cancelled > 0) parts.push(t('js.common.batchCancelled', { count: state.cancelled }).toLowerCase());
    const tail = state.total > 1 && state.succeeded > 1 ? t('js.enhance.zipTail') : '';
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
    clearPreviewThumbnails();
    currentFiles = [];
    selectedId = null;
    progress.hide();
    dropzone.reset();
    dropzone.enable();
    batchRegion.hidden = true;
    announcePreview('');
    announce(t('js.common.readyAgain'));
  }

  async function checkCapabilities() {
    try {
      const report = await ensureWorker().capabilities();
      if (!report?.supported) throw new Error('unsupported');
      ready = true;
      dropzone.enable();
      renderControls();
      announce(t('js.enhance.ready'));
    } catch {
      if (unsupportedNotice) unsupportedNotice.hidden = false;
      dropzone.disable();
      for (const control of [enhanceAllButton, zipButton, autoButton, intensityInput]) {
        if (control) control.disabled = true;
      }
      announce(t('js.enhance.unsupported'), 'error');
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

  enhanceAllButton?.addEventListener('click', () => {
    if (currentFiles.length === 0) return;
    startBatch(currentFiles, { autoStart: true, keepPreviews: true });
  });

  zipButton?.addEventListener('click', () => {
    void downloadAllAsZip();
  });

  // The result panel's save control. Its `href` stays set for a browser with no JavaScript; the
  // tap itself goes through the shared save module, which shares on iOS and opens the viewer in an
  // in-app browser rather than navigating away from the photo.
  wireDownloadAnchor(result.download, {
    getBlob: () => byIdLatest.get(selectedId)?.result?.blob ?? null,
    getFilename: () => nameFor(byIdLatest.get(selectedId)),
    statusEl: statusLine,
  });

  resultPanel.querySelector('[data-start-over]')?.addEventListener('click', startOver);

  for (const [id, chip] of chips) {
    chip.addEventListener('click', () => {
      if (chip.disabled) return;
      setPreset(id);
    });
  }

  autoButton?.addEventListener('click', () => {
    if (autoButton.disabled) return;
    setPreset(AUTO_PRESET_ID);
  });

  intensityInput.addEventListener('input', () => {
    intensity = Number(intensityInput.value) / 100;
    if (intensityOutput) intensityOutput.textContent = `${Math.round(intensity * 100)}%`;
    scheduleLiveRerun();
  });

  if (advancedPanel) {
    const bindAdvanced = (key, transform) => {
      const input = advancedInputs[key];
      if (!input) return;
      input.addEventListener('input', () => {
        advanced = { ...advanced, [key]: transform(Number(input.value)) };
        renderControls();
        scheduleLiveRerun();
      });
    };
    bindAdvanced('brightness', (value) => value / 100);
    bindAdvanced('contrast', (value) => value / 100);
    bindAdvanced('warmth', (value) => value / 100);
    advancedReset?.addEventListener('click', () => {
      advanced = { ...NEUTRAL_ADVANCED };
      renderControls();
      scheduleLiveRerun();
    });
  }

  /*
   * The breakpoint can be crossed without a page load — a phone rotated, a desktop window dragged
   * narrower — and which side of it we are on decides whether the batch row is hidden.
   */
  window.matchMedia(MOBILE_QUERY).addEventListener('change', () => {
    if (queue) renderBatch();
  });

  window.addEventListener('pagehide', () => {
    if (rerunTimer) clearTimeout(rerunTimer);
    disposeQueue();
    clearPreview();
    for (const url of previewUrls) URL.revokeObjectURL(url);
    api?.dispose();
    api = null;
  });

  dropzone.disable();
  renderControls();
  announce(t('js.common.checkingBrowser'));
  void checkCapabilities();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
