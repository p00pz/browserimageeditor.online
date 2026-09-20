/**
 * Crop tool wiring — interactive on the main thread, everything else off it.
 *
 * Flow: dropzone -> cropperjs -> canvas -> convert.worker.js -> compare slider -> download.
 *
 * **Why cropperjs 1.x and not 2.x.** This tool pins `cropperjs@1.6.2` deliberately. 2.2.0 (the
 * current major) exposes `$toCanvas()` on `CropperCanvas` only, has no `$toCanvas()` on the
 * selection and no `$getTransform()` on the image, and its selection rectangle is expressed in the
 * *view's* CSS pixels rather than the image's own pixels. Getting full-resolution cropped pixels
 * out of it would mean reimplementing a function it keeps internal. 1.x answers the exact question
 * with one documented call, `getCroppedCanvas()`, which returns the selected region at natural
 * resolution with rotation and flips already applied. The plan for this phase named that pin as the
 * fallback, and it is now the live path; `core/engine-crop.js` keeps the transform maths that a
 * future v2 migration would need.
 *
 * The job that must stay off the main thread is the re-encode, and it does: the cropped canvas is
 * turned into a PNG blob (a browser API that has no worker equivalent for a DOM canvas) and the
 * real encoding happens in convert.worker.js, which the convert tool uses too. One encoder, not two.
 */
import Cropper from 'cropperjs';

// Bundled by Vite from the package, so there is no separate stylesheet request to keep in step.
import 'cropperjs/dist/cropper.css';

import { CompressError } from '../core/engine-compress.js';
import { openEngine } from '../core/worker-or-main.js';
import { normaliseRotation } from '../core/engine-crop.js';
import { CROP_RATIOS } from '../core/presets.js';
import { flattenForFormat } from '../core/formats.js';
import { primePhotosVariant, wireDownloadAnchor } from '../core/save-photo.js';
import { createCompareSlider } from '../ui/compare-slider.js';
import { createDropzone } from '../ui/dropzone.js';
import { formatBytes } from '../ui/format.js';
import { createProgress } from '../ui/progress.js';
import { markProcessed } from '../ui/pwa.js';
import { localizeError, t } from '../ui/strings.js';

function readConfig() {
  const element = document.getElementById('tool-config');
  if (!element) throw new Error('crop-image: this page is missing its #tool-config block.');
  return JSON.parse(element.textContent);
}

function init() {
  const root = document.querySelector('[data-tool-root]');
  if (!root) return;

  const config = readConfig();
  const dropzoneRoot = root.querySelector('[data-dropzone]');
  const stage = root.querySelector('[data-crop-stage]');
  const image = root.querySelector('[data-crop-image]');
  const toolbar = root.querySelector('[data-crop-toolbar]');
  const ratioList = root.querySelector('[data-ratio-list]');
  const formatSelect = root.querySelector('[data-output-format]');
  const unsupportedNotice = root.querySelector('[data-unsupported]');
  const progressRegion = root.querySelector('[data-progress-region]');
  const resultPanel = root.querySelector('[data-result]');
  const statusLine = root.querySelector('[data-status]');
  const applyButton = root.querySelector('[data-crop-apply]');

  if (!dropzoneRoot || !stage || !image || !toolbar || !progressRegion || !resultPanel || !statusLine) {
    throw new Error('crop-image: this page is missing elements the tool needs.');
  }

  /**
   * The primary action follows the crop toolbar rather than a queue: on a phone it becomes the fixed bar
   * at the bottom of the viewport while there is a selection to apply, so "Apply crop" is reachable
   * without scrolling past the image. It steps aside while a crop is being applied — the progress region
   * owns the panel then — and when no image is loaded. On a desktop the attribute is inert: no rule reads
   * it. This tool crops one image at a time, so there is no batch state to read instead.
   */
  function updateSticky() {
    if (!applyButton) return;
    applyButton.dataset.sticky = !toolbar.hidden && !busy ? 'on' : 'off';
  }

  const progress = createProgress(progressRegion, { label: t('js.crop.progressLabel') });
  const compare = createCompareSlider(root.querySelector('[data-compare]'), {
    savings: root.querySelector('[data-compare-savings]'),
  });

  const result = {
    dimensions: resultPanel.querySelector('[data-result-dimensions]'),
    size: resultPanel.querySelector('[data-result-size]'),
    format: resultPanel.querySelector('[data-result-format]'),
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

  let cropper = null;
  let worker = null;
  let api = null;
  let sourceUrl = null;
  let sourceFile = null;
  let resultUrl = null;
  /** `{ blob, filename }` — the finished crop, cached so a save tap never has to encode anything. */
  let lastResult = null;
  let rotation = 0;
  let flipH = false;
  let flipV = false;
  let currentRatio = null;
  let busy = false;
  let ready = false;

  function announce(message, tone = 'info') {
    statusLine.textContent = message;
    statusLine.classList.toggle('is-error', tone === 'error');
  }

  /**
   * The crop tool uses the convert engine for its re-encode, so there is one encoder in the project
   * rather than two — on a browser without a worker canvas it is the same engine on the main thread.
   */
  function ensureWorker() {
    if (api) return api;
    // See compress-image.js: the worker is constructed here so the bundler can resolve it.
    worker = new Worker(new URL('../workers/convert.worker.js', import.meta.url), { type: 'module' });
    api = openEngine('convert', worker, {
      onError: () => announce(t('js.crop.workerStopped'), 'error'),
    });
    return api;
  }

  /**
   * One place where a failure becomes a sentence.
   *
   * An error thrown here already carries a translated message, so it is passed through. An error
   * that came back across the Comlink boundary arrives as a plain object with the engine's stable
   * `code` and its English sentence, so the code is looked up in this page's catalogue first.
   */
  function normalizeRejection(error) {
    if (error instanceof CompressError) return error;
    if (error && typeof error.code === 'string') {
      return new CompressError(error.code, localizeError(error.code, error.message));
    }
    return new CompressError('INTERNAL', localizeError('INTERNAL', error?.message ?? t('js.crop.failedUnknown')));
  }

  /* ---------- ratio buttons ---------- */

  function renderRatioButtons() {
    if (!ratioList) return;
    for (const preset of CROP_RATIOS) {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'ratio-button';
      element.dataset.ratio = preset.id;
      // The numbers are the preset's own id-based label; the sentence under it is translated. Both
      // come from the catalogue so a new ratio cannot ship an English tooltip on an Arabic page.
      element.textContent = t(`js.ratio.${preset.id}.label`);
      element.title = t(`js.ratio.${preset.id}.note`);
      element.setAttribute('aria-pressed', 'false');
      element.addEventListener('click', () => applyRatio(preset.id));
      ratioList.append(element);
    }
  }

  function applyRatio(id) {
    const preset = CROP_RATIOS.find((entry) => entry.id === id) ?? null;
    currentRatio = preset?.ratio ?? null;
    for (const element of ratioList?.querySelectorAll('.ratio-button') ?? []) {
      element.setAttribute('aria-pressed', element.dataset.ratio === id ? 'true' : 'false');
    }
    // cropperjs 1.x spells this setAspectRatio(NaN) for a free ratio.
    cropper?.setAspectRatio?.(currentRatio ?? Number.NaN);
    const label = t(`js.ratio.${id}.label`);
    announce(currentRatio === null ? t('js.crop.freeSelection') : t('js.crop.lockedTo', { label }));
  }

  /* ---------- cropper lifecycle ---------- */

  function destroyCropper() {
    if (cropper) {
      cropper.destroy();
      cropper = null;
    }
    if (sourceUrl) {
      URL.revokeObjectURL(sourceUrl);
      sourceUrl = null;
    }
  }

  function loadImage(file) {
    destroyCropper();
    clearResult();
    sourceFile = file;
    sourceUrl = URL.createObjectURL(file);
    image.src = sourceUrl;
    stage.hidden = false;
    toolbar.hidden = false;
    updateSticky();
    rotation = 0;
    flipH = false;
    flipV = false;

    cropper = new Cropper(image, {
      // The crop box is what the user drags; `autoCropArea` gives it something to grab on load.
      viewMode: 1,
      autoCropArea: 0.85,
      aspectRatio: currentRatio ?? Number.NaN,
      // Rotation and flips are driven by the toolbar buttons rather than by drag handles, so the
      // image itself is not freely rotatable.
      rotatable: false,
      scalable: false,
      zoomable: true,
      movable: true,
      background: false,
      responsive: true,
    });

    // v1's documented full-resolution export. If it is missing, the installed major is not the one
    // this tool supports, which is worth saying plainly rather than half-working.
    if (typeof cropper.getCroppedCanvas !== 'function') {
      announce(t('js.crop.wrongCropper'), 'error');
      return;
    }
    announce(t('js.crop.dragHint'));
  }

  /* ---------- applying ---------- */

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new CompressError('INVALID_SELECTION', t('js.crop.readBackFailed')));
      }, 'image/png');
    });
  }

  async function applyCrop() {
    if (busy || !cropper) return;
    busy = true;
    updateSticky();
    progress.start(t('js.crop.phaseCrop'));
    try {
      const outputMime = formatSelect?.value || config.defaultOutput;
      // Natural resolution: no width/height are requested, so cropperjs returns the selected
      // region at its own pixel size with the rotation and flips already applied.
      //
      // `fillColor` is conditional because a white fill is baked into the pixels: it rescues a
      // JPEG (which cannot store alpha) and destroys a PNG or WebP (which can). Only the formats
      // that drop transparency get one.
      const canvas = cropper.getCroppedCanvas({
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'high',
        ...(flattenForFormat(outputMime) ? { fillColor: '#ffffff' } : {}),
      });
      if (!canvas || canvas.width < 1 || canvas.height < 1) {
        throw new CompressError('INVALID_SELECTION', t('js.crop.invalidSelection'));
      }

      progress.set(0.4, t('js.crop.phaseEncode'));
      const png = await canvasToBlob(canvas);
      // Dropping the canvas's pixels here is the earliest moment it is safe: the blob holds its own
      // copy, and a natural-resolution crop of a large photo is a large canvas to keep around.
      canvas.width = 0;
      canvas.height = 0;
      const client = ensureWorker();
      const { blob, meta } = await client.convert({
        jobId: `crop-${Date.now()}`,
        file: new File([png], sourceFile?.name ?? 'cropped.png', { type: 'image/png' }),
        options: { outputMime },
      });

      if (resultUrl) URL.revokeObjectURL(resultUrl);
      resultUrl = URL.createObjectURL(blob);
      const extension = config.outputExtensions?.[meta.outputMime] ?? 'png';
      const stem = (sourceFile?.name ?? 'image').replace(/\.[^./\\]+$/, '');
      lastResult = { blob, filename: `${stem}-cropped.${extension}` };
      showResult(meta, meta.width, meta.height);
      progress.finish(t('js.common.done'));
      announce(
        t('js.crop.croppedTo', {
          width: meta.width,
          height: meta.height,
          size: formatBytes(meta.bytes),
        }),
      );
    } catch (error) {
      const message = normalizeRejection(error).message;
      progress.hide();
      announce(message, 'error');
    } finally {
      busy = false;
      updateSticky();
    }
  }

  function showResult(meta, width, height) {
    // See compress-image.js: this is the signal the install banner waits for.
    markProcessed();
    resultPanel.hidden = false;
    compare.setBefore(sourceUrl);
    compare.setAfter(resultUrl);
    compare.setSavings(sourceFile?.size ?? 0, meta.bytes);

    if (result.dimensions) {
      result.dimensions.textContent = `${width}×${height}`;
    }
    if (result.size) result.size.textContent = formatBytes(meta.bytes);
    if (result.format) result.format.textContent = config.outputLabels?.[meta.outputMime] ?? meta.outputMime;
    if (result.download) {
      result.download.href = resultUrl ?? '';
      result.download.download = lastResult?.filename ?? 'cropped.png';
      result.download.textContent = t('js.common.downloadSize', { size: formatBytes(meta.bytes) });
    }
    // Baked now, while the result is merely being shown: an iOS save tap needs a ready file inside
    // its own activation window, so the Photos-friendly copy must not be encoded on that tap.
    void primePhotosVariant({ blob: lastResult?.blob, filename: lastResult?.filename ?? 'cropped.png' });
    if (result.warning) {
      const notes = [];
      if (meta.bytes >= (sourceFile?.size ?? 0)) {
        notes.push(t('js.crop.largerNote'));
      }
      if (meta.flatten) notes.push(t('js.common.jpegFlatten'));
      const text = notes.join(' ');
      result.warning.hidden = text === '';
      result.warning.textContent = text;
    }
    resultPanel.scrollIntoView?.({ block: 'nearest' });
  }

  function clearResult() {
    resultPanel.hidden = true;
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = null;
    lastResult = null;
    compare.reset();
  }

  function startOver() {
    destroyCropper();
    clearResult();
    sourceFile = null;
    stage.hidden = true;
    toolbar.hidden = true;
    updateSticky();
    image.removeAttribute('src');
    progress.hide();
    dropzone.reset();
    dropzone.enable();
    announce(t('js.common.readyAgain'));
  }

  /* ---------- controls ---------- */

  root.querySelector('[data-rotate-right]')?.addEventListener('click', () => {
    rotation = normaliseRotation(rotation + 90);
    if (rotation === 270) cropper?.rotate(-90);
    else cropper?.rotate(90);
    announce(t('js.crop.rotated', { degrees: rotation }));
  });

  root.querySelector('[data-rotate-left]')?.addEventListener('click', () => {
    rotation = normaliseRotation(rotation - 90);
    if (rotation === 90) cropper?.rotate(90);
    else cropper?.rotate(-90);
    announce(t('js.crop.rotated', { degrees: rotation }));
  });

  root.querySelector('[data-flip-h]')?.addEventListener('click', () => {
    flipH = !flipH;
    cropper?.scaleX(flipH ? -1 : 1);
    announce(flipH ? t('js.crop.flipAcross') : t('js.crop.flipAcrossOff'));
  });

  root.querySelector('[data-flip-v]')?.addEventListener('click', () => {
    flipV = !flipV;
    cropper?.scaleY(flipV ? -1 : 1);
    announce(flipV ? t('js.crop.flipDown') : t('js.crop.flipDownOff'));
  });

  root.querySelector('[data-crop-reset]')?.addEventListener('click', () => {
    rotation = 0;
    flipH = false;
    flipV = false;
    cropper?.reset();
    applyRatio('free');
    announce(t('js.crop.selectionReset'));
  });

  applyButton?.addEventListener('click', () => {
    void applyCrop();
  });

  root.querySelector('[data-crop-choose-another]')?.addEventListener('click', startOver);
  resultPanel.querySelector('[data-start-over]')?.addEventListener('click', startOver);

  // The result panel's save control. Its `href` stays set — a browser with no JavaScript still
  // downloads through it — while the tap goes through the shared save module, which shares on iOS
  // and opens the press-and-hold viewer inside an in-app browser instead of leaving the page.
  wireDownloadAnchor(result.download, {
    getBlob: () => lastResult?.blob ?? null,
    getFilename: () => lastResult?.filename,
    statusEl: statusLine,
  });

  const dropzone = createDropzone(dropzoneRoot, {
    accept: config.accepts ?? [],
    maxBytes: config.maxInputBytes ?? 50 * 1024 * 1024,
    multiple: false,
    onFiles: (files) => {
      // A second image replaces the first: one crop at a time, which is what the UI promises.
      if (busy) return;
      loadImage(files[0]);
    },
    onReject: (reason) => announce(reason.message, 'error'),
  });

  async function checkCapabilities() {
    try {
      const report = await ensureWorker().capabilities();
      if (!report?.supported) throw new Error('unsupported');
      if (typeof Cropper !== 'function') throw new Error('no cropper');
      ready = true;
      dropzone.enable();
      announce(t('js.crop.ready'));
    } catch {
      if (unsupportedNotice) unsupportedNotice.hidden = false;
      dropzone.disable();
      announce(t('js.crop.unsupported'), 'error');
    }
  }

  renderRatioButtons();
  // Ratio buttons are built from CROP_RATIOS and the preset defaults were validated against that
  // same list, so an unknown ratio id cannot reach here. `free` is the default when a page does not
  // ask for a lock.
  const defaults = config.defaults ?? {};
  applyRatio(CROP_RATIOS.some((entry) => entry.id === defaults.ratioId) ? defaults.ratioId : 'free');

  window.addEventListener('pagehide', () => {
    destroyCropper();
    clearResult();
    api?.dispose();
    api = null;
  });

  dropzone.disable();
  toolbar.hidden = true;
  stage.hidden = true;
  announce(t('js.common.checkingBrowser'));
  void checkCapabilities();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
