import { CompressError } from './errors.js';

export function upscaleSize(width, height, scale = 1, maxPixels = 16000000) {
  scale = Number(scale);
  if (![1, 2, 4].includes(scale)) throw new CompressError('INVALID_SCALE', 'Choose 1×, 2× or 4×.');
  const output = { width: width * scale, height: height * scale };
  if (![width, height].every((n) => Number.isInteger(n) && n > 0) || output.width * output.height > maxPixels || Math.max(output.width, output.height) > 8192) {
    throw new CompressError('UPSCALE_TOO_LARGE', 'This output is too large for safe processing. Choose a smaller scale or resize the original first.');
  }
  return { ...output, pixels: output.width * output.height, scale };
}

function cubic(x) {
  x = Math.abs(x);
  return x <= 1 ? (1.5 * x - 2.5) * x * x + 1 : x < 2 ? ((-.5 * x + 2.5) * x - 4) * x + 2 : 0;
}
function taps(length, scale) {
  return Array.from({ length: length * scale }, (_, i) => {
    const position = (i + .5) / scale - .5;
    const first = Math.floor(position) - 1;
    return Array.from({ length: 4 }, (_, j) => [Math.max(0, Math.min(length - 1, first + j)), cubic(position - first - j)]);
  });
}

/** Separable bicubic resampling, premultiplied alpha, four cached rows, cooperative cancellation.
 * This dependency-free seam can later be replaced by a local model without changing the UI. */
export async function upscalePixels(source, width, height, scale, { signal, onProgress, maxPixels } = {}) {
  const size = upscaleSize(width, height, scale, maxPixels);
  const check = () => { if (signal?.aborted) throw new CompressError('ABORTED', 'Processing was cancelled.'); };
  check();
  if (source.length !== width * height * 4) throw new CompressError('INVALID_INPUT', 'Invalid pixel buffer.');
  if (size.scale === 1) return { ...size, pixels: source };
  const output = new Uint8ClampedArray(size.pixels * 4);
  const xt = taps(width, size.scale);
  const yt = taps(height, size.scale);
  const rows = new Map();
  let lastYield = performance.now();
  for (let y = 0; y < size.height; y++) {
    check();
    const needed = new Set(yt[y].map(([row]) => row));
    for (const key of rows.keys()) if (!needed.has(key)) rows.delete(key);
    for (const row of needed) {
      if (rows.has(row)) continue;
      const values = new Float32Array(size.width * 4);
      for (let x = 0; x < size.width; x++) {
        for (const [column, weight] of xt[x]) {
          const at = (row * width + column) * 4;
          const alpha = source[at + 3] / 255;
          for (let c = 0; c < 3; c++) values[x * 4 + c] += source[at + c] * alpha * weight;
          values[x * 4 + 3] += source[at + 3] * weight;
        }
      }
      rows.set(row, values);
    }
    for (let x = 0; x < size.width; x++) {
      let red = 0, green = 0, blue = 0, opacity = 0;
      const x4 = x * 4;
      for (const [row, weight] of yt[y]) {
        const values = rows.get(row);
        red += values[x4] * weight;
        green += values[x4 + 1] * weight;
        blue += values[x4 + 2] * weight;
        opacity += values[x4 + 3] * weight;
      }
      const at = (y * size.width + x) * 4;
      const alpha = Math.max(0, Math.min(255, opacity));
      const unpremultiply = alpha > .01 ? 255 / alpha : 0;
      output[at] = red * unpremultiply;
      output[at + 1] = green * unpremultiply;
      output[at + 2] = blue * unpremultiply;
      output[at + 3] = alpha;
    }
    if (performance.now() - lastYield > 12) {
      onProgress?.(y / size.height);
      await new Promise((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }
  check();
  return { ...size, pixels: output };
}
