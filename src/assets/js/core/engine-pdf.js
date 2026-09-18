/**
 * PDF page planning — pure logic, no DOM and no pdf-lib.
 *
 * The worker does the byte-level work (embed, draw, save); what decides where an image lands on
 * its page is arithmetic, so it lives here and is unit-tested. Mistakes in this file look like
 * "the photo is cropped at the edge" or "there's a grey band down one side", which is exactly the
 * kind of thing that is painful to spot by eye across a dozen images.
 *
 * Units are PDF points (72 to the inch).
 *
 * One coordinate detail worth stating plainly: a canvas measures y downwards from the top-left,
 * and PDF measures it upwards from the bottom-left. `planPage` works top-down because that is how
 * people read a page layout, and `toPdfBox` does the single flip into pdf-lib's frame. Keeping
 * that conversion in exactly one function is why it can be tested.
 */
import { CompressError } from './errors.js';

/** Page sizes, plus "match each image", which sizes every page to its own picture. */
export const PAGE_SIZES = [
  {
    id: 'a4',
    label: 'A4 (210 × 297 mm)',
    width: 595.28,
    height: 841.89,
    note: 'The default almost everywhere except North America.',
  },
  {
    id: 'letter',
    label: 'US Letter (8.5 × 11 in)',
    width: 612,
    height: 792,
    note: 'US Letter, 612 × 792 points.',
  },
  {
    id: 'match',
    label: 'Match each image',
    width: null,
    height: null,
    note: 'Every page is the size of its own image, so nothing is padded or cropped. Margins do not apply.',
  },
];

export const MARGINS = [
  { id: 'none', label: 'None', points: 0, note: 'The image fills the printable area.' },
  { id: 'small', label: 'Small (0.25 in)', points: 18 },
  { id: 'normal', label: 'Normal (0.5 in)', points: 36 },
];

/** JPEG quality used when an image has to be transcoded before it can go into a PDF. */
export const QUALITIES = [
  { id: 'high', label: 'High (JPEG 95%)', quality: 0.95 },
  { id: 'balanced', label: 'Balanced (JPEG 85%)', quality: 0.85 },
  { id: 'small', label: 'Smaller file (JPEG 70%)', quality: 0.7 },
];

/** CSS pixels are 96 to the inch and PDF points are 72, which is the whole of this constant. */
export const POINTS_PER_PIXEL = 72 / 96;

export function findPageSize(id) {
  return PAGE_SIZES.find((size) => size.id === id) ?? null;
}

export function findMargin(id) {
  return MARGINS.find((margin) => margin.id === id) ?? null;
}

export function findQuality(id) {
  return QUALITIES.find((quality) => quality.id === id) ?? null;
}

/**
 * Where one image goes on its page.
 *
 *   - A4 and Letter: the page turns to match a landscape image, and the image is fitted inside
 *     the margins and centred, so a portrait photo on a landscape sheet is never squashed.
 *   - match: the page becomes the image, scaled from CSS pixels to points, and margins are
 *     ignored rather than turning into an uneven border.
 */
export function planPage({
  imageWidth,
  imageHeight,
  pageSizeId = 'a4',
  marginId = 'normal',
  marginPoints = null,
} = {}) {
  if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight) || imageWidth < 1 || imageHeight < 1) {
    throw new CompressError('INVALID_DIMENSIONS', 'An image reported a size of zero and cannot be placed on a page.');
  }

  const size = findPageSize(pageSizeId);
  if (!size) throw new CompressError('INVALID_PAGE_SIZE', `Unknown page size "${pageSizeId}".`);

  if (size.id === 'match') {
    const pageWidth = Math.max(1, Math.round(imageWidth * POINTS_PER_PIXEL));
    const pageHeight = Math.max(1, Math.round(imageHeight * POINTS_PER_PIXEL));
    return {
      mode: 'match',
      pageWidth,
      pageHeight,
      drawWidth: pageWidth,
      drawHeight: pageHeight,
      x: 0,
      y: 0,
      landscape: imageWidth > imageHeight,
      margin: 0,
    };
  }

  const margin = Number.isFinite(marginPoints) ? marginPoints : (findMargin(marginId)?.points ?? 0);
  const landscape = imageWidth > imageHeight;
  const pageWidth = landscape ? size.height : size.width;
  const pageHeight = landscape ? size.width : size.height;

  const innerWidth = Math.max(1, pageWidth - margin * 2);
  const innerHeight = Math.max(1, pageHeight - margin * 2);
  const scale = Math.min(innerWidth / imageWidth, innerHeight / imageHeight);
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;

  return {
    mode: size.id,
    pageWidth,
    pageHeight,
    drawWidth,
    drawHeight,
    x: (pageWidth - drawWidth) / 2,
    y: (pageHeight - drawHeight) / 2,
    landscape,
    margin,
  };
}

/**
 * How an image's bytes get into the PDF.
 *
 *   passthrough     PNG has no orientation metadata, so the original bytes are embedded exactly as
 *                   they arrived: lossless, and nothing is decoded and re-encoded for no reason.
 *   transcode-jpeg  Everything else is redrawn through a canvas first. For JPEG that is not
 *                   optional: pdf-lib embeds a JPEG byte-for-byte, EXIF orientation included, so
 *                   a portrait phone photo would land on its side. Redrawing applies the
 *                   orientation the browser decoded with.
 */
export function embedStrategy(mime) {
  return mime === 'image/png' ? 'passthrough' : 'transcode-jpeg';
}

/** The same placement in pdf-lib's frame, where y grows upwards from the bottom-left corner. */
export function toPdfBox(placement) {
  return {
    x: placement.x,
    y: placement.pageHeight - placement.y - placement.drawHeight,
    width: placement.drawWidth,
    height: placement.drawHeight,
  };
}

/**
 * How many images may be held at once before the batch gets a warning. The PDF is assembled in
 * memory, so this is a memory bound rather than a limit on the format.
 */
export const PDF_PAGE_WARNING = 200;

/** A one-line summary for the result panel. */
export function describePdf({ pages, bytes, pageSizeId }) {
  const size = findPageSize(pageSizeId);
  return {
    pages,
    pageSizeLabel: size ? size.label : pageSizeId,
    bytes,
    bulk: pages > PDF_PAGE_WARNING,
  };
}
