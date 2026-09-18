/**
 * Reorder list — a reusable component for "these items, in this order".
 *
 * The image-to-PDF tool needs it because the list order becomes the page order, and nothing else
 * in the project lets a person rearrange anything. It is written as a component rather than inline
 * markup because the next tool that needs ordering should not write a second one.
 *
 * The component owns no state: the caller keeps the array and re-renders after applying whatever
 * `onMove` asked for. Movement is requested with `{ id, action }`, where action is one of
 * `first | up | down | last | remove`.
 *
 * Accessibility: every control is a real button, so tabbing and Enter work with no extra code, and
 * each button carries a label naming the file it acts on rather than just "move up".
 */

export function createOrderList(root, { onMove, labels = {} } = {}) {
  if (!root) throw new Error('createOrderList: a root element is required.');

  const text = {
    moveUp: labels.moveUp ?? 'Move up',
    moveDown: labels.moveDown ?? 'Move down',
    moveFirst: labels.moveFirst ?? 'Move to start',
    moveLast: labels.moveLast ?? 'Move to end',
    remove: labels.remove ?? 'Remove',
  };

  function handle(item, action) {
    onMove?.({ id: item.id, action });
  }

  function makeButton(item, action, label, glyph) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'order-button';
    element.dataset.action = action;
    element.textContent = glyph;
    element.setAttribute('aria-label', `${label}: ${item.name}`);
    element.addEventListener('click', () => handle(item, action));
    return element;
  }

  /** `items` is `[{ id, name, meta? }]`, already in the order that should be shown. */
  function render(items = []) {
    root.replaceChildren();

    items.forEach((item, index) => {
      const row = document.createElement('li');
      row.className = 'order-item';
      row.dataset.id = item.id;

      const position = document.createElement('span');
      position.className = 'order-position';
      position.textContent = String(index + 1);

      const main = document.createElement('div');
      main.className = 'order-item-main';
      const name = document.createElement('span');
      name.className = 'order-item-name';
      name.textContent = item.name;
      main.append(name);
      if (item.meta) {
        const meta = document.createElement('span');
        meta.className = 'order-item-meta';
        meta.textContent = item.meta;
        main.append(meta);
      }

      const actions = document.createElement('div');
      actions.className = 'order-item-actions';
      const first = makeButton(item, 'first', text.moveFirst, '⇤');
      const up = makeButton(item, 'up', text.moveUp, '↑');
      const down = makeButton(item, 'down', text.moveDown, '↓');
      const last = makeButton(item, 'last', text.moveLast, '⇥');
      const remove = makeButton(item, 'remove', text.remove, '✕');
      remove.classList.add('order-button-remove');

      // Disabled rather than hidden, so the row's layout does not jump as items move.
      if (index === 0) {
        first.disabled = true;
        up.disabled = true;
      }
      if (index === items.length - 1) {
        down.disabled = true;
        last.disabled = true;
      }

      actions.append(first, up, down, last, remove);
      row.append(position, main, actions);
      root.append(row);
    });
  }

  return { render };
}

/** Applies a move request to an array, returning a new array. Pure, so it can be tested. */
export function applyMove(items, { id, action }) {
  const list = Array.isArray(items) ? items.slice() : [];
  const index = list.findIndex((item) => item.id === id);
  if (index === -1) return list;

  if (action === 'remove') {
    list.splice(index, 1);
    return list;
  }

  const target =
    action === 'first' ? 0 : action === 'last' ? list.length - 1 : action === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= list.length || target === index) return list;
  const [moved] = list.splice(index, 1);
  list.splice(target, 0, moved);
  return list;
}
