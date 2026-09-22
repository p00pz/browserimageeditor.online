import { planDocument } from '../core/engine-pdf.js';
import { t } from './strings.js';

export function createPdfPreview(root) {
  const cache = new Map();
  let generation = 0, current = 0, plans = [], items = [];
  const paper = root.querySelector('[data-pdf-paper]');
  const status = root.querySelector('[data-pdf-preview-status]');
  const previous = root.querySelector('[data-preview-previous]');
  const next = root.querySelector('[data-preview-next]');
  function paint() {
    paper.replaceChildren();
    current = Math.max(0, Math.min(current, plans.length - 1));
    previous.disabled = current === 0;
    next.disabled = current >= plans.length - 1;
    if (!plans.length) return;
    const plan = plans[current];
    paper.style.aspectRatio = `${plan.pageWidth} / ${plan.pageHeight}`;
    status.textContent = t('js.pdf.previewPage', { page: current + 1, pages: plans.length, images: items.length });
    for (const cell of plan.cells) {
      const item = items[cell.index];
      const image = document.createElement('img');
      image.src = cache.get(item.id).url;
      image.alt = `${cell.index + 1}: ${item.file.name}`;
      image.style.cssText = `left:${cell.x / plan.pageWidth * 100}%;top:${cell.y / plan.pageHeight * 100}%;width:${cell.drawWidth / plan.pageWidth * 100}%;height:${cell.drawHeight / plan.pageHeight * 100}%;`;
      paper.append(image);
    }
  }
  previous.addEventListener('click', () => { current--; paint(); });
  next.addEventListener('click', () => { current++; paint(); });
  async function update(nextItems, options) {
    const version = ++generation;
    items = [...nextItems];
    root.hidden = !items.length;
    for (const [id, entry] of cache) {
      if (!items.some((item) => item.id === id)) { URL.revokeObjectURL(entry.url); cache.delete(id); }
    }
    if (!items.length) { plans = []; paper.replaceChildren(); return; }
    status.textContent = t('js.pdf.previewLoading');
    try {
      // Decode metadata sequentially; only the current PDF page is mounted as a preview.
      for (const item of items) {
        if (!cache.has(item.id)) {
          const url = URL.createObjectURL(item.file);
          const entry = { url };
          entry.ready = new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => { entry.width = image.naturalWidth; entry.height = image.naturalHeight; image.src = ''; resolve(); };
            image.onerror = () => reject(new Error('decode'));
            image.src = url;
          });
          cache.set(item.id, entry);
        }
        await cache.get(item.id).ready;
        if (version !== generation) return;
      }
      plans = planDocument(items.map((item) => cache.get(item.id)), options);
      paint();
    } catch {
      if (version !== generation) return;
      paper.replaceChildren();
      previous.disabled = next.disabled = true;
      status.textContent = t('js.pdf.previewFailed');
    }
  }
  return { update, destroy() { generation++; for (const entry of cache.values()) URL.revokeObjectURL(entry.url); cache.clear(); } };
}
