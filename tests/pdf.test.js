/**
 * PDF page planning. Run with `npm test`.
 *
 * These assertions are all about geometry a reader would judge instantly and a unit test can
 * judge exactly: the image fits inside the margins, it is centred, landscape images get landscape
 * pages, and pdf-lib's bottom-left origin is handled in one place.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MARGINS,
  PAGE_SIZES,
  POINTS_PER_PIXEL,
  QUALITIES,
  describePdf,
  embedStrategy,
  findMargin,
  findPageSize,
  findQuality,
  planPage,
  toPdfBox,
} from '../src/assets/js/core/engine-pdf.js';
import { CompressError } from '../src/assets/js/core/errors.js';

const A4 = findPageSize('a4');

test('a tall photo uses an upright A4 page and sits inside the margins', () => {
  const placement = planPage({ imageWidth: 1000, imageHeight: 1500, pageSizeId: 'a4', marginId: 'normal' });
  assert.equal(placement.pageWidth, A4.width);
  assert.equal(placement.pageHeight, A4.height);
  assert.equal(placement.landscape, false);

  // The height is the binding side, so the top and bottom margins are exactly the margin.
  assert.equal(Math.round(placement.y), 36);
  assert.ok(Math.abs(placement.x - (A4.width - placement.drawWidth) / 2) < 1e-9, 'horizontally centred');
  assert.ok(placement.drawWidth <= A4.width - 72 + 1e-9);
  assert.ok(placement.drawHeight <= A4.height - 72 + 1e-9);
  assert.ok(Math.abs(placement.drawWidth / placement.drawHeight - 1000 / 1500) < 1e-9, 'aspect ratio kept');
});

test('a wide photo gets a landscape page rather than being shrunk to fit portrait', () => {
  const placement = planPage({ imageWidth: 1600, imageHeight: 900, pageSizeId: 'a4', marginId: 'normal' });
  assert.equal(placement.landscape, true);
  assert.equal(placement.pageWidth, A4.height);
  assert.equal(placement.pageHeight, A4.width);
  assert.ok(placement.drawWidth > placement.drawHeight, 'the wide photo stays wide');
  assert.ok(Math.abs(placement.drawWidth / placement.drawHeight - 1600 / 900) < 1e-9);
});

test('US Letter stays Letter, and its own dimensions are used', () => {
  const letter = findPageSize('letter');
  const placement = planPage({ imageWidth: 1000, imageHeight: 1000, pageSizeId: 'letter', marginId: 'none' });
  assert.equal(placement.mode, 'letter');
  assert.equal(placement.pageWidth, letter.width);
  assert.equal(placement.pageHeight, letter.height);
  assert.equal(placement.margin, 0);
});

test('a square image on a page with no margin fills the short side exactly', () => {
  const placement = planPage({ imageWidth: 1000, imageHeight: 1000, pageSizeId: 'a4', marginId: 'none' });
  assert.equal(Math.round(placement.drawWidth), Math.round(placement.drawHeight));
  assert.ok(Math.abs(placement.x - (placement.pageWidth - placement.drawWidth) / 2) < 1e-9);
  assert.equal(Math.round(placement.x * 2 + placement.drawWidth), Math.round(placement.pageWidth));
});

test('"match each image" sizes the page to the picture and ignores margins', () => {
  const placement = planPage({ imageWidth: 1080, imageHeight: 1350, pageSizeId: 'match', marginId: 'normal' });
  assert.equal(placement.mode, 'match');
  assert.equal(placement.margin, 0);
  assert.equal(placement.pageWidth, Math.round(1080 * POINTS_PER_PIXEL));
  assert.equal(placement.pageHeight, Math.round(1350 * POINTS_PER_PIXEL));
  assert.deepEqual([placement.x, placement.y], [0, 0]);
  assert.equal(POINTS_PER_PIXEL, 0.75);
});

test('an explicit margin in points overrides the named one', () => {
  const placement = planPage({ imageWidth: 1000, imageHeight: 1000, pageSizeId: 'a4', marginPoints: 100 });
  assert.equal(placement.margin, 100);
  assert.ok(placement.drawHeight <= A4.height - 200 + 1e-9);
});

test('the pdf-lib box flips y exactly once, from the page bottom', () => {
  const placement = planPage({ imageWidth: 1000, imageHeight: 1500, pageSizeId: 'a4', marginId: 'normal' });
  const box = toPdfBox(placement);
  assert.equal(box.width, placement.drawWidth);
  assert.equal(box.height, placement.drawHeight);
  assert.equal(box.x, placement.x);
  assert.ok(Math.abs(box.y - (placement.pageHeight - placement.y - placement.drawHeight)) < 1e-9);
  // Top and bottom margins match, because the image is centred.
  assert.ok(Math.abs(box.y - placement.y) < 1e-9);
});

test('a page nobody defined is refused, and a zero-sized image never reaches the writer', () => {
  assert.throws(
    () => planPage({ imageWidth: 100, imageHeight: 100, pageSizeId: 'a5' }),
    (error) => error instanceof CompressError && error.code === 'INVALID_PAGE_SIZE',
  );
  assert.throws(() => planPage({ imageWidth: 0, imageHeight: 100 }), (error) => error.code === 'INVALID_DIMENSIONS');
});

test('the option lists are complete and identify themselves', () => {
  assert.equal(PAGE_SIZES.length, 3);
  assert.deepEqual(
    PAGE_SIZES.map((size) => size.id),
    ['a4', 'letter', 'match'],
  );
  assert.ok(MARGINS.every((margin) => Number.isFinite(margin.points)));
  assert.ok(QUALITIES.every((quality) => quality.quality > 0 && quality.quality <= 1));
  assert.equal(findMargin('nope'), null);
  assert.equal(findQuality('nope'), null);
  assert.equal(findQuality('balanced').quality, 0.85);
});

test('only PNG is embedded as-is, because a JPEG carries its orientation in its own bytes', () => {
  // pdf-lib writes a JPEG byte-for-byte, EXIF orientation included, so a portrait phone photo
  // would land on its side unless it is redrawn first. PNG has no orientation metadata.
  assert.equal(embedStrategy('image/png'), 'passthrough');
  assert.equal(embedStrategy('image/jpeg'), 'transcode-jpeg');
  assert.equal(embedStrategy('image/webp'), 'transcode-jpeg');
});

test('the summary names the page size and flags a bulk batch', () => {
  const small = describePdf({ pages: 3, bytes: 120_000, pageSizeId: 'a4' });
  assert.equal(small.pages, 3);
  assert.match(small.pageSizeLabel, /A4/);
  assert.equal(small.bulk, false);
  assert.equal(describePdf({ pages: 500, bytes: 1, pageSizeId: 'letter' }).bulk, true);
});
