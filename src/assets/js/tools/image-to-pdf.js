/**
 * Image → PDF wiring — dropzone + order list + core/queue.js + pdf.worker.js + core/file-io.js.
 *
 * The batch here is different from the other tools, and the code says so plainly: the output is a
 * *single* file assembled from every input, so there is no per-file download and no ZIP. The
 * per-image work still goes through core/queue.js at concurrency 1, which is what gives per-image
 * progress, ordered results, retry and a cancel that reaches the worker — and concurrency 1 is a
 * memory decision, because every prepared page is held until the document is written.
 *
 * Order is the page order, so the list is the interface: ui/order-list.js renders it and this file
 * owns the array.
 */
import * as Comlink from 'comlink';

import { CompressError } from '../core/engine-compress.js';
import { MARGINS, PAGE_SIZES, PDF_PAGE_WARNING, QUALITIES, findPageSize } from '../core/engine-pdf.js';
import { createQueue } from '../core/queue.js';
import { downloadBlob } from '../core/file-io.js';
import { createOrderList, applyMove } from '../ui/order-list.js';
import { createDropzone } from '../ui/dropzone.js';
import { formatBytes } from '../ui/format.js';
import { createProgress } from '../ui/progress.js';
import { markProcessed } from '../ui/pwa.js';
import { localizeError, t } from '../ui/strings.js';

/**
 * A worker phase is a stable name rather than a sentence, so the catalogue decides the wording and
 * a phase added to the worker tomorrow cannot render as an English string on an Arabic page.
 */
const PHASE_KEYS = {
  probe: 'js.pdf.phaseProbe',
  encode: 'js.pdf.phaseEncode',
};

/** One at a time: every prepared page is held in memory until the PDF is written. */
const CONCURRENCY = 1;
const PDF_NAME = 'browserimageeditor-images.pdf';

function readConfig() {
  const element = document.getElementById('tool-config');
  if (!element) throw new Error('image-to-pdf: this page is missing its #tool-config block.');
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
  const pageSizeSelect = root.querySelector('[data-page-size]');
  const marginSelect = root.querySelector('[data-margin]');
  const qualitySelect = root.querySelector('[data-quality]');
  const orderRegion = root.querySelector('[data-order]');
  const orderListRoot = root.querySelector('[data-order-list]');
  const orderSummary = root.querySelector('[data-order-summary]');
  const buildButton = root.querySelector('[data-build-pdf]');
  const clearButton = root.querySelector('[data-clear-list]');
  const progressRegion = root.querySelector('[data-progress-region]');
  const cancelButton = root.querySelector('[data-cancel]');
  const unsupportedNotice = root.querySelector('[data-unsupported]');
  const resultPanel = root.querySelector('[data-result]');
  const statusLine = root.querySelector('[data-status]');

  if (!dropzoneRoot || !orderListRoot || !progressRegion || !resultPanel || !statusLine || !buildButton) {
    throw new Error('image-to-pdf: this page is missing elements the tool needs.');
  }

  const progress = createProgress(progressRegion, { label: t('js.pdf.progressLabel') });
  const result = {
    pages: resultPanel.querySelector('[data-result-pages]'),
    pageSize: resultPanel.querySelector('[data-result-page-size]'),
    size: resultPanel.querySelector('[data-result-size]'),
    warning: resultPanel.querySelector('[data-result-warning]'),
    download: resultPanel.querySelector('[data-download]'),
  };

  /**
   * The option lists come from core/engine-pdf.js, which owns the ids and the geometry; their words
   * come from this page's catalogue as `js.pdf.<family>.<id>.label`. Keeping the two apart is what
   * lets an Arabic page offer the same page sizes without a second copy of the numbers.
   */
  function fillSelect(select, family, entries) {
    if (!select) return;
    for (const entry of entries) {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = t(`js.pdf.${family}.${entry.id}.label`);
      if (entry.note) option.title = t(`js.pdf.${family}.${entry.id}.note`);
      select.append(option);
    }
  }

  fillSelect(pageSizeSelect, 'pageSize', PAGE_SIZES);
  fillSelect(marginSelect, 'margin', MARGINS);
  fillSelect(qualitySelect, 'quality', QUALITIES);
  if (marginSelect) marginSelect.value = 'normal';
  if (qualitySelect) qualitySelect.value = 'balanced';

  // A target page's pre-set choices replace those built-in defaults. The ids were validated against
  // these same lists when the content was loaded, so an unknown one cannot reach the page.
  if (pageSizeSelect && defaults.pageSizeId) pageSizeSelect.value = defaults.pageSizeId;
  if (marginSelect && defaults.marginId) marginSelect.value = defaults.marginId;
  if (qualitySelect && defaults.qualityId) qualitySelect.value = defaults.qualityId;

  /** [{ id, file }] — the array is the page order. */
  let items = [];
  let sequence = 0;
  let worker = null;
  let api = null;
  let progressProxy = null;
  let queue = null;
  let busy = false;
  let ready = false;
  let resultUrl = null;

  const orderList = createOrderList(orderListRoot, {
    labels: {
      moveUp: t('js.order.moveUp'),
      moveDown: t('js.order.moveDown'),
      moveFirst: t('js.order.moveFirst'),
      moveLast: t('js.order.moveLast'),
      remove: t('js.order.remove'),
    },
    onMove: ({ id, action }) => {
      if (busy) return;
      items = applyMove(items, { id, action });
      renderOrder();
    },
  });

  function announce(message, tone = 'info') {
    statusLine.textContent = message;
    statusLine.classList.toggle('is-error', tone === 'error');
  }

  function ensureWorker() {
    if (api) return api;
    worker = new Worker(new URL('../workers/pdf.worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('error', () => {
      announce(t('js.pdf.workerStopped'), 'error');
    });
    api = Comlink.wrap(worker);
    progressProxy = Comlink.proxy(handleProgress);
    return api;
  }

  function handleProgress(update) {
    if (!update) return;
    const key = PHASE_KEYS[update.phase];
    progress.set(update.ratio ?? 0, key ? t(key) : t('js.pdf.working'));
  }

  /** See crop-image.js: our own errors are already translated; a worker's error is looked up by code. */
  function normalizeRejection(error) {
    if (error instanceof CompressError) return error;
    if (error && typeof error.code === 'string') {
      return new CompressError(error.code, localizeError(error.code, error.message));
    }
    return new CompressError('INTERNAL', localizeError('INTERNAL', error?.message ?? t('js.pdf.failedUnknown')));
  }

  function renderOrder() {
    orderRegion.hidden = items.length === 0;
    buildButton.disabled = items.length === 0 || busy;
    /*
     * The primary action becomes the fixed bar at the bottom of a phone's viewport while there is a list
     * to build from, so "Build PDF" is reachable without scrolling past the drop zone and three selects.
     * It steps aside while a PDF is being built — the progress region owns the panel then, and its Cancel
     * button is the action that matters — and when the list is empty. On a desktop the attribute is inert:
     * no rule reads it.
     */
    buildButton.dataset.sticky = items.length > 0 && !busy ? 'on' : 'off';
    orderList.render(
      items.map((item) => ({
        id: item.id,
        name: item.file.name,
        meta: formatBytes(item.file.size),
      })),
    );
    const output = findPageSize(pageSizeSelect?.value ?? 'a4');
    const size = t(`js.pdf.pageSize.${output?.id ?? 'a4'}.label`);
    orderSummary.textContent = items.length === 0
      ? ''
      : t(items.length > PDF_PAGE_WARNING ? 'js.pdf.orderTooLong' : 'js.pdf.orderSummary', {
          count: items.length,
          pages: items.length === 1 ? t('js.pdf.pageOne') : t('js.pdf.pageMany'),
          size,
        });
  }

  function pagesFromQueue() {
    const state = queue?.snapshot() ?? null;
    if (!state) return [];
    return state.items
      .filter((item) => item.status === 'done' && item.result)
      .map((item) => ({
        bytes: item.result.bytes,
        mime: item.result.mime,
        width: item.result.width,
        height: item.result.height,
      }));
  }

  async function build() {
    if (busy || !ready || items.length === 0) return;
    busy = true;
    /* Recomputes `disabled` and the sticky attribute together, so the two cannot disagree. */
    renderOrder();
    dropzone.disable();
    clearResult();
    progress.start(
      t('js.pdf.startingPages', {
        count: items.length,
        pages: items.length === 1 ? t('js.pdf.pageOne') : t('js.pdf.pageMany'),
      }),
    );
    announce(
      t('js.pdf.starting', {
        count: items.length,
        images: items.length === 1 ? t('js.common.imageOne') : t('js.common.imageMany'),
      }),
    );

    queue?.dispose();
    queue = createQueue({
      concurrency: CONCURRENCY,
      onUpdate: (state) => {
        const total = state.total || 1;
        progress.set(
          (state.finished / total) * 0.9,
          t(state.failed > 0 ? 'js.pdf.preparedFailed' : 'js.pdf.prepared', {
            done: state.finished,
            total,
            failed: state.failed,
          }),
        );
      },
      run: async (file, { id, signal, report }) => {
        report(0.05);
        const client = ensureWorker();
        const forwardAbort = () => {
          void client.cancel(id);
        };
        signal.addEventListener('abort', forwardAbort, { once: true });
        try {
          const page = await client.encodePage(
            { jobId: id, file, options: { qualityId: qualitySelect?.value ?? 'balanced' } },
            progressProxy,
          );
          report(1);
          return page;
        } catch (error) {
          throw normalizeRejection(error);
        } finally {
          signal.removeEventListener('abort', forwardAbort);
        }
      },
    });

    try {
      const state = await queue.process(items.map((item) => item.file));
      if (state.failed > 0 && state.succeeded === 0) {
        throw new CompressError('PDF_FAILED', t('js.pdf.couldNotPrepareAll'));
      }
      const pages = pagesFromQueue();
      if (pages.length === 0) throw new CompressError('PDF_FAILED', t('js.pdf.nothingToPut'));

      progress.set(0.95, t('js.pdf.writing'));
      const client = ensureWorker();
      const { blob, meta } = await client.assemble({
        pages,
        options: {
          pageSizeId: pageSizeSelect?.value ?? 'a4',
          marginId: marginSelect?.value ?? 'normal',
          qualityId: qualitySelect?.value ?? 'balanced',
          title: items[0]?.file?.name?.replace(/\.[^./\\]+$/, '') ?? t('js.pdf.docTitleFallback'),
        },
      });

      if (resultUrl) URL.revokeObjectURL(resultUrl);
      resultUrl = URL.createObjectURL(blob);
      showResult(meta, pages);
      progress.finish(t('js.common.done'));
      announce(
        t('js.pdf.readySummary', {
          count: meta.pages,
          pages: meta.pages === 1 ? t('js.pdf.pageOne') : t('js.pdf.pageMany'),
          size: formatBytes(meta.bytes),
        }),
      );
    } catch (error) {
      progress.hide();
      announce(normalizeRejection(error).message, 'error');
    } finally {
      busy = false;
      renderOrder();
      dropzone.enable();
    }
  }

  function showResult(meta, pages) {
    // See compress-image.js: this is the signal the install banner waits for.
    markProcessed();
    const size = findPageSize(meta.pageSizeId);
    resultPanel.hidden = false;
    if (result.pages) result.pages.textContent = String(meta.pages);
    if (result.pageSize) result.pageSize.textContent = t(`js.pdf.pageSize.${meta.pageSizeId}.label`);
    if (result.size) result.size.textContent = formatBytes(meta.bytes);
    if (result.download) {
      result.download.href = resultUrl ?? '';
      result.download.download = PDF_NAME;
      result.download.textContent = t('js.pdf.downloadSize', { size: formatBytes(meta.bytes) });
    }
    if (result.warning) {
      const notes = [];
      const transcoded = pages.filter((page) => page.mime !== 'image/png').length;
      if (transcoded > 0) {
        notes.push(
          t(transcoded === 1 ? 'js.pdf.transcodedOne' : 'js.pdf.transcoded', {
            count: transcoded,
            total: pages.length,
            images: t('js.common.imageMany'),
          }),
        );
      }
      if (meta.pages > PDF_PAGE_WARNING) {
        notes.push(t('js.pdf.largeDoc'));
      }
      const text = notes.join(' ');
      result.warning.hidden = text === '';
      result.warning.textContent = text;
    }
  }

  function clearResult() {
    resultPanel.hidden = true;
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = null;
  }

  function clearAll() {
    if (busy) return;
    queue?.dispose();
    queue = null;
    items = [];
    clearResult();
    progress.hide();
    renderOrder();
    announce(t('js.pdf.listCleared'));
  }

  function startOver() {
    if (busy) return;
    clearAll();
    dropzone.reset();
    dropzone.enable();
    announce(t('js.pdf.ready'));
  }

  buildButton.addEventListener('click', () => {
    void build();
  });
  clearButton?.addEventListener('click', clearAll);
  cancelButton?.addEventListener('click', () => {
    if (!busy || !queue) return;
    announce(t('js.common.cancelling'));
    queue.cancel();
  });
  resultPanel.querySelector('[data-start-over]')?.addEventListener('click', startOver);

  for (const select of [pageSizeSelect, marginSelect, qualitySelect]) {
    select?.addEventListener('change', renderOrder);
  }

  const dropzone = createDropzone(dropzoneRoot, {
    accept: config.accepts ?? [],
    maxBytes: config.maxInputBytes ?? 50 * 1024 * 1024,
    multiple: true,
    onFiles: (files) => {
      // Adding more images appends: this tool is built around accumulating a document, unlike the
      // others where a new drop starts a new batch.
      if (busy) return;
      for (const file of files) {
        sequence += 1;
        items.push({ id: `page-${sequence}`, file });
      }
      clearResult();
      renderOrder();
      announce(
        t('js.pdf.imagesReady', {
          count: items.length,
          images: items.length === 1 ? t('js.common.imageOne') : t('js.common.imageMany'),
        }),
      );
    },
    onReject: (reason) => announce(reason.message, 'error'),
  });

  async function checkCapabilities() {
    try {
      const report = await ensureWorker().capabilities();
      if (!report?.supported) throw new Error('unsupported');
      ready = true;
      dropzone.enable();
      announce(t('js.pdf.ready'));
    } catch {
      if (unsupportedNotice) unsupportedNotice.hidden = false;
      dropzone.disable();
      buildButton.disabled = true;
      announce(t('js.pdf.unsupported'), 'error');
    }
  }

  renderOrder();

  window.addEventListener('pagehide', () => {
    queue?.dispose();
    clearResult();
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
