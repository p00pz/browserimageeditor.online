/**
 * Reorder logic for the PDF page list. Run with `npm test`.
 *
 * `applyMove` is deliberately separated from the component that renders the buttons, so the part
 * that can actually be wrong (the index arithmetic at the ends of the list) is tested without a DOM.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { applyMove } from '../src/assets/js/ui/order-list.js';

const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
const ids = (list) => list.map((item) => item.id);

test('moving down swaps with the next item and leaves the rest alone', () => {
  assert.deepEqual(ids(applyMove(items, { id: 'a', action: 'down' })), ['b', 'a', 'c']);
  assert.deepEqual(ids(applyMove(items, { id: 'b', action: 'down' })), ['a', 'c', 'b']);
});

test('moving up swaps with the previous item', () => {
  assert.deepEqual(ids(applyMove(items, { id: 'c', action: 'up' })), ['a', 'c', 'b']);
});

test('first and last jump the whole way', () => {
  assert.deepEqual(ids(applyMove(items, { id: 'c', action: 'first' })), ['c', 'a', 'b']);
  assert.deepEqual(ids(applyMove(items, { id: 'a', action: 'last' })), ['b', 'c', 'a']);
});

test('removing takes the item out and keeps the order of the rest', () => {
  assert.deepEqual(ids(applyMove(items, { id: 'b', action: 'remove' })), ['a', 'c']);
});

test('a move off either end is a no-op rather than an error', () => {
  assert.deepEqual(ids(applyMove(items, { id: 'a', action: 'up' })), ['a', 'b', 'c']);
  assert.deepEqual(ids(applyMove(items, { id: 'c', action: 'down' })), ['a', 'b', 'c']);
  assert.deepEqual(ids(applyMove(items, { id: 'a', action: 'first' })), ['a', 'b', 'c']);
  assert.deepEqual(ids(applyMove(items, { id: 'c', action: 'last' })), ['a', 'b', 'c']);
});

test('an unknown id changes nothing, and the original array is never mutated', () => {
  const original = items.slice();
  assert.deepEqual(ids(applyMove(items, { id: 'zzz', action: 'up' })), ['a', 'b', 'c']);
  assert.deepEqual(ids(items), ids(original), 'applyMove returns a new array');
  assert.deepEqual(applyMove(undefined, { id: 'a', action: 'up' }), []);
});
