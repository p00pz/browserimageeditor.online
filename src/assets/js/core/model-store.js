/**
 * Model store — download a weight file once, keep it for every later visit.
 *
 * The two models this site runs are 4.4 MB and 198 MB. Neither is committed to the repository and
 * neither is served from our own origin: the browser fetches them from a public Hugging Face
 * repository, at the moment a visitor actually uses the tool, and stores the bytes in the Cache API
 * so the second visit is instant and offline.
 *
 * **Why the Cache API rather than the service worker.** The service worker deliberately ignores
 * cross-origin requests (`url.origin !== self.location.origin` returns early), because caching
 * someone else's URLs behind a site's own install step is not its job. So this cache is ours,
 * explicit, and inspectable — it appears in the Application tab next to the site's own caches.
 *
 * **`ignoreVary` on every lookup, and it is not decorative.** Cache Storage refuses a stored
 * response when the request's `Vary`-listed headers differ from the request that stored it, and
 * CDNs set `Vary: Origin` routinely. Hugging Face's CDN does serve CORS-enabled responses, so this
 * is the same trap that once made the whole site fail offline (see scripts/templates/sw.js). The
 * bytes are identified by their URL and by the size recorded in content/tools.json, which is more
 * than `Vary` could tell us.
 *
 * **Storing is best-effort.** Browsers cap Cache Storage at a fraction of free disk, and a 198 MB
 * model can legitimately be refused. When that happens the download is still usable for this
 * session, and the caller is told it was not persisted so the UI can be honest instead of promising
 * a fast second visit it cannot deliver.
 */
import { CompressError } from './errors.js';

export const MODEL_CACHE_NAME = 'browserimageeditor-models';

/** Report download progress at most this often, so a 198 MB fetch does not post 20 000 messages. */
const PROGRESS_STEP_BYTES = 512 * 1024;
const PROGRESS_STEP_MS = 120;

function cacheStorage() {
  try {
    return typeof caches === 'undefined' ? null : caches;
  } catch {
    // Some private-browsing modes throw on access rather than returning undefined.
    return null;
  }
}

async function openModelCache() {
  const storage = cacheStorage();
  if (!storage) return null;
  try {
    return await storage.open(MODEL_CACHE_NAME);
  } catch {
    return null;
  }
}

/** True when this model is already stored, so the UI can say "ready" without a network request. */
export async function hasStoredModel(url) {
  const cache = await openModelCache();
  if (!cache) return false;
  try {
    return Boolean(await cache.match(url, { ignoreVary: true }));
  } catch {
    return false;
  }
}

/** Drops one stored model. Exported so a future "free up space" control has something to call. */
export async function forgetModel(url) {
  const cache = await openModelCache();
  if (!cache) return false;
  try {
    return await cache.delete(url, { ignoreVary: true });
  } catch {
    return false;
  }
}

/**
 * Returns the model's bytes, from the cache when possible.
 *
 *   url             the exact file URL (content/tools.json)
 *   expectedBytes   the size recorded in content/tools.json; a mismatch is a hard failure, because
 *                   a truncated model is 198 MB of unusable download that fails much later, deep
 *                   inside inference, with an opaque error
 *   onProgress      ({ phase, received, total, ratio }) — phase is 'cache' or 'download'
 *   signal          AbortSignal, so the UI can cancel a 198 MB download
 */
export async function loadModelBytes({ url, expectedBytes = null, onProgress, signal } = {}) {
  if (!url) throw new CompressError('MODEL_URL_MISSING', 'No model URL was configured.');

  const cache = await openModelCache();
  if (cache) {
    try {
      const cached = await cache.match(url, { ignoreVary: true });
      if (cached) {
        const bytes = new Uint8Array(await cached.arrayBuffer());
        // A cached copy that does not match the recorded size is treated as absent: better to
        // re-download than to run inference against half a model.
        if (expectedBytes === null || bytes.byteLength === expectedBytes) {
          onProgress?.({ phase: 'cache', received: bytes.byteLength, total: bytes.byteLength, ratio: 1 });
          return { bytes, source: 'cache', persisted: true };
        }
      }
    } catch {
      // A cache read failure is never fatal: fall through to the network.
    }
  }

  let response;
  try {
    response = await fetch(url, { signal, mode: 'cors', credentials: 'omit', cache: 'default' });
  } catch (error) {
    if (signal?.aborted) throw new CompressError('ABORTED', 'The model download was cancelled.');
    throw new CompressError(
      'MODEL_FETCH_FAILED',
      'The model could not be downloaded. Check your connection and try again — nothing was uploaded either way.',
    );
  }

  if (!response.ok) {
    throw new CompressError(
      'MODEL_HTTP',
      `The model host answered with status ${response.status}. The model may have moved; nothing was uploaded.`,
    );
  }

  const total = Number(response.headers.get('content-length')) || expectedBytes || null;
  const declared = expectedBytes ?? total;
  const bytes = await readWithProgress(response, { total, expectedBytes: declared, onProgress, signal });

  if (declared !== null && bytes.byteLength !== declared) {
    throw new CompressError(
      'MODEL_TRUNCATED',
      `The model download was incomplete (${bytes.byteLength} of ${declared} bytes). Nothing was uploaded; try again.`,
    );
  }

  let persisted = false;
  if (cache) {
    try {
      await cache.put(
        url,
        new Response(bytes, {
          headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength) },
        }),
      );
      persisted = true;
    } catch {
      // Quota, or a cache that refuses large entries. The bytes are still returned and usable.
      persisted = false;
    }
  }

  return { bytes, source: 'network', persisted, total: declared };
}

/** Streams the body so progress is real rather than a spinner that lies. */
async function readWithProgress(response, { total, expectedBytes, onProgress, signal }) {
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onProgress?.({ phase: 'download', received: bytes.byteLength, total: total ?? bytes.byteLength, ratio: 1 });
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  let lastReportedBytes = 0;
  let lastReportedAt = 0;

  for (;;) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      throw new CompressError('ABORTED', 'The model download was cancelled.');
    }
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;

    const now = Date.now();
    if (received - lastReportedBytes >= PROGRESS_STEP_BYTES || now - lastReportedAt >= PROGRESS_STEP_MS) {
      lastReportedBytes = received;
      lastReportedAt = now;
      onProgress?.({
        phase: 'download',
        received,
        total: total ?? expectedBytes ?? null,
        ratio: total ? Math.min(1, received / total) : null,
      });
    }
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onProgress?.({
    phase: 'download',
    received,
    total: total ?? expectedBytes ?? received,
    ratio: 1,
  });
  return bytes;
}
