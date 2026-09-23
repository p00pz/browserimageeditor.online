import { t } from './strings.js';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function liveToolLinks(current) {
  const seen = new Set();
  return [...document.querySelectorAll('.nav-link[href]')].flatMap((anchor) => {
    const url = new URL(anchor.href, location.origin);
    const match = url.pathname.match(/(?:^|\/)tools\/([\w-]+)\/?$/);
    if (!match || match[1] === current || seen.has(match[1])) return [];
    seen.add(match[1]);
    return [{ slug: match[1], path: url.pathname, label: anchor.textContent.trim() }];
  });
}

/** A one-use, same-origin handoff. Bytes live only in the two open tabs, never in storage. */
export function receiveHandoff(onFile) {
  if (typeof window === 'undefined' || !window.opener || !/^#edit-[\w-]+$/.test(location.hash)) return () => {};
  const token = location.hash.slice(1);
  const source = window.opener;
  let timer;
  const cleanup = () => { window.removeEventListener('message', receive); clearTimeout(timer); };
  function receive(event) {
    if (event.origin !== location.origin || event.source !== source || event.data?.token !== token || event.data?.kind !== 'image-edit-file') return;
    if (!(event.data.file instanceof File) || !IMAGE_TYPES.includes(event.data.file.type)) return;
    cleanup();
    history.replaceState(null, '', location.pathname + location.search);
    window.opener = null;
    onFile(event.data.file);
  }
  window.addEventListener('message', receive);
  timer = setTimeout(cleanup, 30000);
  source.postMessage({ kind: 'image-edit-ready', token }, location.origin);
  return cleanup;
}

export function attachHandoff(anchor, { getBlob, getFilename, statusEl }) {
  const result = anchor.closest?.('[data-result]');
  if (!result || typeof window === 'undefined') return () => {};
  const current = document.querySelector('[data-tool-slug]')?.dataset.toolSlug;
  if (current === 'image-to-pdf') return () => {};
  const tools = liveToolLinks(current);
  if (!tools.length) return () => {};
  const region = document.createElement('div');
  region.className = 'next-tool';
  const label = document.createElement('label');
  label.textContent = t('js.handoff.label');
  const select = document.createElement('select');
  select.id = 'next-tool-select';
  label.htmlFor = select.id;
  for (const tool of tools) {
    const option = document.createElement('option');
    option.value = tool.slug;
    option.dataset.path = tool.path;
    option.textContent = tool.label || tool.slug;
    select.append(option);
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button button-secondary';
  button.textContent = t('js.handoff.open');
  let cleanup = () => {};
  button.addEventListener('click', () => {
    const blob = getBlob?.();
    if (!blob || !IMAGE_TYPES.includes(blob.type)) {
      if (statusEl) statusEl.textContent = t('js.handoff.unavailable');
      return;
    }
    cleanup();
    const file = new File([blob], getFilename?.() || 'edited-image', { type: blob.type });
    const token = 'edit-' + crypto.randomUUID();
    const path = select.selectedOptions[0]?.dataset.path;
    if (!path) {
      if (statusEl) statusEl.textContent = t('js.handoff.unavailable');
      return;
    }
    const child = window.open(path + '#' + token, '_blank');
    if (!child) {
      if (statusEl) statusEl.textContent = t('js.handoff.blocked');
      return;
    }
    button.disabled = true;
    let timer;
    cleanup = () => { window.removeEventListener('message', ready); clearTimeout(timer); button.disabled = false; };
    function ready(event) {
      if (event.origin !== location.origin || event.source !== child || event.data?.kind !== 'image-edit-ready' || event.data.token !== token) return;
      child.postMessage({ kind: 'image-edit-file', token, file }, location.origin);
      cleanup();
    }
    window.addEventListener('message', ready);
    timer = setTimeout(() => {
      cleanup();
      if (statusEl) statusEl.textContent = t('js.handoff.timeout');
    }, 30000);
  });
  region.append(label, select, button);
  result.append(region);
  return () => { cleanup(); region.remove(); };
}
