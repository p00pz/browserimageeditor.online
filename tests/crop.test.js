/**
 * Crop geometry. Run with `npm test`.
 *
 * This suite is the reason the crop tool computes its own transform: the rotation and flip maths
 * is the part that silently produces a wrong-sized or mirrored image, and here it is checked
 * exactly, corner by corner, instead of by eye in a browser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyMatrix,
  clampRect,
  compose,
  initialSelection,
  normaliseRotation,
  planCrop,
  rotation,
  scaling,
  translation,
} from '../src/assets/js/core/engine-crop.js';
import { CompressError } from '../src/assets/js/core/errors.js';

/** Where the four corners of the source rectangle land in the output, rounded. */
function corners(plan, rect = plan.rect) {
  const points = [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x + rect.width, rect.y + rect.height],
    [rect.x, rect.y + rect.height],
  ];
  return points.map(([x, y]) => applyMatrix(plan.matrix, x, y)).map(({ x, y }) => ({ x: Math.round(x), y: Math.round(y) }));
}

test('rotations snap to the quarter turn the interface can mean', () => {
  assert.equal(normaliseRotation(0), 0);
  assert.equal(normaliseRotation(90), 90);
  assert.equal(normaliseRotation(-90), 270);
  assert.equal(normaliseRotation(450), 90);
  assert.equal(normaliseRotation(361), 0);
  assert.equal(normaliseRotation('nonsense'), 0);
});

test('a selection is clamped inside the image and given whole pixels', () => {
  assert.deepEqual(clampRect({ x: -20, y: -5, width: 200, height: 300 }, 100, 100), {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  });
  assert.deepEqual(clampRect({ x: 90, y: 90, width: 50, height: 50 }, 100, 100), {
    x: 90,
    y: 90,
    width: 10,
    height: 10,
  });
  assert.deepEqual(clampRect({ x: 10.4, y: 20.6, width: 30.5, height: 40.4 }, 1000, 1000), {
    x: 10,
    y: 21,
    width: 31,
    height: 40,
  });
  assert.throws(() => clampRect(null, 100, 100), (error) => error.code === 'INVALID_SELECTION');
  assert.throws(() => clampRect({ x: 0, y: 0, width: 1, height: 1 }, 0, 100), (error) => error.code === 'INVALID_DIMENSIONS');
});

test('an unrotated crop keeps the selection size and maps its origin to 0,0', () => {
  const plan = planCrop({ sourceWidth: 4000, sourceHeight: 3000, rect: { x: 100, y: 200, width: 800, height: 600 } });
  assert.equal(plan.outputWidth, 800);
  assert.equal(plan.outputHeight, 600);
  assert.equal(plan.swapped, false);
  assert.deepEqual(corners(plan), [
    { x: 0, y: 0 },
    { x: 800, y: 0 },
    { x: 800, y: 600 },
    { x: 0, y: 600 },
  ]);
});

test('a quarter turn swaps the output dimensions and keeps every pixel inside the canvas', () => {
  const plan = planCrop({
    sourceWidth: 4000,
    sourceHeight: 3000,
    rect: { x: 10, y: 20, width: 100, height: 50 },
    rotation: 90,
  });
  assert.equal(plan.outputWidth, 50, 'a 100x50 selection turned 90 degrees is 50 wide');
  assert.equal(plan.outputHeight, 100);
  assert.equal(plan.swapped, true);

  for (const point of corners(plan)) {
    assert.ok(point.x >= 0 && point.x <= plan.outputWidth, `x ${point.x} outside 0..${plan.outputWidth}`);
    assert.ok(point.y >= 0 && point.y <= plan.outputHeight, `y ${point.y} outside 0..${plan.outputHeight}`);
  }
});

test('every quarter turn produces the right box, whatever the angle', () => {
  const rect = { x: 30, y: 40, width: 200, height: 120 };
  const expectations = {
    0: [200, 120],
    90: [120, 200],
    180: [200, 120],
    270: [120, 200],
  };
  for (const [angle, [width, height]] of Object.entries(expectations)) {
    const plan = planCrop({ sourceWidth: 1000, sourceHeight: 1000, rect, rotation: Number(angle) });
    assert.deepEqual([plan.outputWidth, plan.outputHeight], [width, height], `rotation ${angle}`);
    for (const point of corners(plan)) {
      assert.ok(point.x >= 0 && point.x <= plan.outputWidth, `rotation ${angle}: x out of range`);
      assert.ok(point.y >= 0 && point.y <= plan.outputHeight, `rotation ${angle}: y out of range`);
    }
  }
});

test('a horizontal flip mirrors the result inside its own box', () => {
  const plain = planCrop({ sourceWidth: 1000, sourceHeight: 1000, rect: { x: 0, y: 0, width: 100, height: 80 } });
  const flipped = planCrop({
    sourceWidth: 1000,
    sourceHeight: 1000,
    rect: { x: 0, y: 0, width: 100, height: 80 },
    flipH: true,
  });
  assert.deepEqual([flipped.outputWidth, flipped.outputHeight], [100, 80]);
  const origin = applyMatrix(flipped.matrix, 0, 0);
  assert.equal(Math.round(origin.x), 100, 'the top-left corner moves to the right edge');
  assert.equal(Math.round(origin.y), 0);

  const plainOrigin = applyMatrix(plain.matrix, 0, 0);
  assert.deepEqual([Math.round(plainOrigin.x), Math.round(plainOrigin.y)], [0, 0]);
});

test('a vertical flip mirrors the other way, and both together turn the image upside down', () => {
  const both = planCrop({
    sourceWidth: 1000,
    sourceHeight: 1000,
    rect: { x: 0, y: 0, width: 100, height: 80 },
    flipH: true,
    flipV: true,
  });
  assert.deepEqual([both.outputWidth, both.outputHeight], [100, 80]);
  const origin = applyMatrix(both.matrix, 0, 0);
  assert.deepEqual([Math.round(origin.x), Math.round(origin.y)], [100, 80]);
});

test('flipping plus a quarter turn keeps the swapped box', () => {
  const plan = planCrop({
    sourceWidth: 1000,
    sourceHeight: 1000,
    rect: { x: 5, y: 5, width: 200, height: 100 },
    rotation: 270,
    flipH: true,
  });
  assert.deepEqual([plan.outputWidth, plan.outputHeight], [100, 200]);
  for (const point of corners(plan)) {
    assert.ok(point.x >= 0 && point.x <= plan.outputWidth);
    assert.ok(point.y >= 0 && point.y <= plan.outputHeight);
  }
});

test('an enormous crop is refused before a canvas is created', () => {
  assert.throws(
    () => planCrop({ sourceWidth: 30000, sourceHeight: 30000, rect: { x: 0, y: 0, width: 30000, height: 30000 } }),
    (error) => error.code === 'IMAGE_TOO_LARGE',
  );
});

test('the initial selection is centred and honours a locked ratio', () => {
  // 0.8 of 4000x3000 is a 3200x2400 box; a 1:1 ratio then takes the shorter side.
  const square = initialSelection({ sourceWidth: 4000, sourceHeight: 3000, ratio: 1 });
  assert.deepEqual(square, { x: 800, y: 300, width: 2400, height: 2400 });

  const free = initialSelection({ sourceWidth: 4000, sourceHeight: 3000, coverage: 0.5 });
  assert.deepEqual(free, { x: 1000, y: 750, width: 2000, height: 1500 });
});

test('matrix helpers compose in the documented order', () => {
  // Translate by (10, 0), then scale by 2: the translation is scaled along with everything else.
  const combined = compose(scaling(2, 2), translation(10, 0));
  assert.deepEqual(applyMatrix(combined, 0, 0), { x: 20, y: 0 });

  // cos(90 degrees) is 6.1e-17 rather than 0, so the quarter turn is checked to within rounding.
  const turned = applyMatrix(rotation(90), 1, 0);
  assert.equal(Math.round(turned.x), 0);
  assert.equal(Math.round(turned.y), 1);

  assert.equal(normaliseRotation('nonsense'), 0, 'a junk angle is treated as no rotation');
});
