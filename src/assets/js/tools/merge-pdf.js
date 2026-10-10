import { createDropzone } from '../ui/dropzone.js';
import { createOrderList, applyMove } from '../ui/order-list.js';
import { createProgress } from '../ui/progress.js';
import { startPdfMergeJob } from '../ui/pdf-merge-job.js';
import { formatBytes } from '../ui/format.js';
import { hasString, t } from '../ui/strings.js';

const root = document.querySelector('[data-tool-root]');
if (root) {
  const find = (selector) => root.querySelector(selector);
  const list = find('[data-order-list]');
  const status = find('[data-status]');
  const errors = find('[data-errors]');
  const summary = find('[data-summary]');
  const merge = find('[data-merge]');
  const clear = find('[data-clear]');
  const result = find('[data-result]');
  const download = find('[data-download]');
  const progress = createProgress(find('[data-progress-region]'));
  let items = [];
  let nextId = 0;
  let job = null;
  let busy = false;
  let resultUrl = null;

  function invalidate() {
    result.hidden = true;
    download.removeAttribute('href');
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = null;
  }
  function announce(message) { status.textContent = message; }
  function resetErrors() { errors.replaceChildren(); errors.hidden = true; }
  function showError(name, code) {
    const row = document.createElement('li');
    const key = `js.merge.error.${code}`;
    row.textContent = t('js.merge.fileError', { name, reason: t(hasString(key) ? key : 'js.merge.error.FAILED') });
    errors.append(row);
    errors.hidden = false;
  }
  const order = createOrderList(list, {
    labels: { moveUp: t('js.order.moveUp'), moveDown: t('js.order.moveDown'), moveFirst: t('js.order.moveFirst'), moveLast: t('js.order.moveLast'), remove: t('js.order.remove') },
    onMove(request) {
      if (busy) return;
      const index = items.findIndex((item) => item.id === request.id);
      const name = items[index].file.name;
      items = applyMove(items, request);
      invalidate();
      render();
      const target = items.find((item) => item.id === request.id) ?? items[Math.min(index, items.length - 1)];
      const row = [...list.children].find((element) => element.dataset.id === target?.id);
      // Keep keyboard focus on the moved file, even when the same action is now disabled.
      const button = row?.querySelector(`[data-action="${request.action}"]:not(:disabled)`) ?? row?.querySelector('button:not(:disabled)');
      (button ?? find('[data-dropzone-input]')).focus();
      announce(request.action === 'remove' ? t('js.merge.removed', { name }) : t('js.merge.moved', { name, position: items.indexOf(target) + 1 }));
    },
  });
  function render() {
    order.render(items.map((item) => ({ id: item.id, name: item.file.name, meta: t('js.merge.fileMeta', { pages: item.pages, size: formatBytes(item.file.size) }) })));
    for (const button of list.querySelectorAll('button')) button.disabled ||= busy;
    summary.textContent = items.length ? t('js.merge.summary', { count: items.length, pages: items.reduce((sum, item) => sum + item.pages, 0) }) : t('js.merge.empty');
    merge.disabled = busy || items.length < 2;
    clear.disabled = busy || !items.length;
  }
  function setBusy(value) {
    busy = value;
    root.setAttribute('aria-busy', String(value));
    value ? dropzone.disable() : dropzone.enable();
    render();
  }
  async function run(payload, label) {
    setBusy(true);
    progress.start(label);
    announce(label);
    try {
      job = startPdfMergeJob(payload, (ratio) => progress.set(ratio, label));
      return await job.promise;
    } finally { job = null; setBusy(false); progress.hide(); }
  }
  const dropzone = createDropzone(find('[data-dropzone]'), {
    multiple: true,
    async onFiles(files) {
      if (busy) return;
      resetErrors();
      try {
        const results = await run({ operation: 'inspect', files, existing: { count: items.length, bytes: items.reduce((sum, item) => sum + item.file.size, 0), pages: items.reduce((sum, item) => sum + item.pages, 0) } }, t('js.merge.checking'));
        const accepted = results.filter((entry) => !entry.error);
        if (accepted.length) invalidate();
        for (const entry of results) {
          if (entry.error) showError(files[entry.index].name, entry.error);
          else items.push({ id: String(++nextId), file: files[entry.index], pages: entry.pages });
        }
        render();
        announce(t('js.merge.added', { count: accepted.length, rejected: results.length - accepted.length }));
      } catch (error) { announce(t(error.code === 'CANCELLED' ? 'js.merge.cancelled' : 'js.merge.error.FAILED')); }
    },
  });
  merge.addEventListener('click', async () => {
    if (busy || items.length < 2) return;
    invalidate();
    resetErrors();
    try {
      const output = await run({ operation: 'merge', files: items.map((item) => item.file) }, t('js.merge.merging'));
      resultUrl = URL.createObjectURL(output.blob);
      download.href = resultUrl;
      find('[data-result-info]').textContent = t('js.merge.result', { pages: output.pages, size: formatBytes(output.blob.size) });
      result.hidden = false;
      announce(t('js.merge.ready'));
      download.focus();
    } catch (error) {
      if (error.code === 'CANCELLED') announce(t('js.merge.cancelled'));
      else { showError(error.fileName || t('js.merge.output'), error.code ?? 'FAILED'); announce(t('js.merge.error.FAILED')); }
    }
  });
  find('[data-cancel]').addEventListener('click', () => job?.cancel());
  clear.addEventListener('click', () => { if (busy) return; items = []; invalidate(); resetErrors(); dropzone.reset(); render(); announce(t('js.merge.cleared')); find('[data-dropzone-input]').focus(); });
  window.addEventListener('pagehide', () => { job?.cancel(); invalidate(); });
  render();
}
