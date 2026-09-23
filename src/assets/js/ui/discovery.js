/** Progressive discovery and privacy-preserving favorites. Image files never enter local storage. */
import { t } from './strings.js';

const FAVORITES_KEY = 'browserimageeditor:favorites';

export function initDiscovery() {
  const root = document.querySelector('[data-discovery]');
  if (!root) return;
  const search = root.querySelector('input[type="search"]');
  const cards = [...root.querySelectorAll('.tool-card')];
  const status = root.querySelector('[data-search-status]');
  const clear = root.querySelector('[data-search-clear]');
  const controls = root.querySelector('[data-search-controls]');
  const filters = [...root.querySelectorAll('[data-category-filter]')];
  const favoriteButtons = [...root.querySelectorAll('[data-favorite-toggle]')];
  const normalize = (value) => value.normalize('NFKD').replace(/[\u064b-\u065f]/g, '').toLocaleLowerCase().trim();
  const knownSlugs = new Set(favoriteButtons.map((button) => button.dataset.favoriteToggle));
  let favorites = readFavorites();
  let activeFilter = 'all';

  function readFavorites() {
    try {
      const value = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
      return new Set(Array.isArray(value) ? value.filter((slug) => knownSlugs.has(slug)) : []);
    } catch {
      return new Set();
    }
  }

  function writeFavorites() {
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites]));
      return true;
    } catch {
      return false;
    }
  }

  function updateFavoriteButton(button) {
    const selected = favorites.has(button.dataset.favoriteToggle);
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('aria-label', t(selected ? 'js.favorite.remove' : 'js.favorite.add'));
    button.textContent = selected ? '★' : '☆';
    button.hidden = false;
  }

  function filter() {
    const terms = normalize(search.value).split(/\s+/).filter(Boolean);
    let count = 0;
    for (const card of cards) {
      const favorite = card.querySelector('[data-favorite-toggle]');
      const categoryMatches =
        activeFilter === 'all' ||
        (activeFilter === 'favorites'
          ? Boolean(favorite && favorites.has(favorite.dataset.favoriteToggle))
          : card.dataset.category === activeFilter);
      const text = normalize(card.textContent);
      card.hidden = !(categoryMatches && terms.every((term) => text.includes(term)));
      if (!card.hidden) count++;
    }
    if (status) {
      status.textContent = activeFilter === 'favorites' && count === 0
        ? t('js.favorite.empty')
        : terms.length || activeFilter !== 'all'
          ? (count ? status.dataset.found.replace('{count}', count) : status.dataset.empty)
          : '';
    }
    if (clear) clear.hidden = !search.value;
  }

  for (const button of favoriteButtons) {
    updateFavoriteButton(button);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const slug = button.dataset.favoriteToggle;
      if (favorites.has(slug)) favorites.delete(slug);
      else favorites.add(slug);
      updateFavoriteButton(button);
      filter();
      if (status) status.textContent = writeFavorites() ? t('js.favorite.saved') : t('js.favorite.storageUnavailable');
    });
  }

  for (const button of filters) {
    button.addEventListener('click', () => {
      activeFilter = button.dataset.categoryFilter;
      for (const item of filters) item.setAttribute('aria-pressed', String(item === button));
      filter();
    });
  }

  search.addEventListener('input', filter);
  clear.addEventListener('click', () => { search.value = ''; filter(); search.focus(); });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { search.value = ''; filter(); }
  });
  controls.hidden = false;
}
