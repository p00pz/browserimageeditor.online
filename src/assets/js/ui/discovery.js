/** Progressive tool discovery. Filtering never changes the underlying crawlable links. */
export function initDiscovery() {
  const root = document.querySelector('[data-discovery]');
  if (!root) return;
  const search = root.querySelector('input[type="search"]');
  const cards = [...root.querySelectorAll('.tool-card')];
  const status = root.querySelector('[data-search-status]');
  const clear = root.querySelector('[data-search-clear]');
  const normalize = (value) => value.normalize('NFKD').replace(/[\u064b-\u065f]/g, '').toLocaleLowerCase().trim();
  function filter() {
    const terms = normalize(search.value).split(/\s+/).filter(Boolean);
    let count = 0;
    for (const card of cards) {
      const text = normalize(card.textContent);
      card.hidden = !terms.every((term) => text.includes(term));
      if (!card.hidden) count++;
    }
    status.textContent = terms.length ? (count ? status.dataset.found.replace('{count}', count) : status.dataset.empty) : '';
    clear.hidden = !search.value;
  }
  search.addEventListener('input', filter);
  clear.addEventListener('click', () => { search.value = ''; filter(); search.focus(); });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { search.value = ''; filter(); }
  });
  root.querySelector('[data-search-controls]').hidden = false;
}
