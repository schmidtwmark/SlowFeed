import { createHash } from 'crypto';
import os from 'os';
import { createWorker, type Worker } from 'tesseract.js';
import { query } from './db.js';
import { logger } from './logger.js';

/**
 * Optical character recognition for post images, so words that only appear
 * inside a picture — meme captions, screenshots of articles, the text card on
 * a video's poster frame — are findable through search.
 *
 * Runs at poll time (see `enrichWithImageOCR` in digest.ts) rather than on the
 * client, because search is a server-side SQL scan over posts_json: text has
 * to be in the stored post for a query to match it. Tesseract is used because
 * the server runs on Linux, where Apple's Vision framework isn't available.
 *
 * Everything here is best-effort. OCR failures never fail a poll — a post
 * without extracted text is just a post that search can't match on its
 * imagery.
 */

/** Hard ceiling on images processed per digest, so one image-heavy poll can't
 *  stall the run. Excess images are skipped (and logged), not queued. */
const MAX_IMAGES_PER_DIGEST = 60;
/** Give up on a single image rather than let a slow decode block the poll. */
const PER_IMAGE_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10_000;
/** Skip anything implausibly large; these are feed images, not scans. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** Tesseract emits noise on textureless photos; below this it isn't signal. */
const MIN_CONFIDENCE = 40;
const MAX_TEXT_LENGTH = 4000;

function hashURL(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

async function getCached(urls: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (urls.length === 0) return found;
  const hashes = urls.map(hashURL);
  const { rows } = await query<{ url: string; text: string }>(
    `SELECT url, text FROM image_ocr WHERE url_hash = ANY($1)`,
    [hashes]
  );
  for (const row of rows) found.set(row.url, row.text);
  return found;
}

async function putCached(url: string, text: string): Promise<void> {
  await query(
    `INSERT INTO image_ocr (url_hash, url, text) VALUES ($1, $2, $3)
     ON CONFLICT (url_hash) DO UPDATE SET text = $3`,
    [hashURL(url), url, text]
  );
}

async function downloadImage(url: string): Promise<Buffer | null> {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Slowfeed/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const contentType = resp.headers.get('content-type') || '';
    // GIFs are usually animated and decode poorly; SVGs aren't raster at all.
    if (!/^image\/(png|jpe?g|webp|bmp|tiff)/i.test(contentType)) return null;
    const length = Number(resp.headers.get('content-length') || 0);
    if (length > MAX_IMAGE_BYTES) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength > MAX_IMAGE_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

/** Clean OCR output into something worth storing and searching. */
function tidy(raw: string): string {
  return raw
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .split('\n')
    .map(line => line.trim())
    // Drop lines that are mostly punctuation noise — a common tesseract
    // artifact on textured photos.
    .filter(line => line.length > 1 && /[a-z0-9]/i.test(line))
    .join('\n')
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

/**
 * Extract text from a batch of image URLs. Cached results come from the DB;
 * only genuinely new images pay for a download + recognition pass. The
 * tesseract worker is created once per batch and torn down after, so the
 * ~100 MB WASM heap isn't held between polls.
 */
export async function ocrImages(urls: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(urls.filter(u => /^https?:\/\//i.test(u))));
  const results = await getCached(unique);

  const pending = unique.filter(u => !results.has(u));
  if (pending.length === 0) return results;

  const batch = pending.slice(0, MAX_IMAGES_PER_DIGEST);
  if (pending.length > batch.length) {
    logger.info(`OCR: ${pending.length - batch.length} image(s) skipped (per-digest cap)`);
  }

  let worker: Worker | null = null;
  try {
    // cachePath under tmp: the container filesystem is ephemeral and the app
    // directory isn't reliably writable on Railway.
    worker = await createWorker('eng', undefined, { cachePath: os.tmpdir() });
  } catch (err) {
    logger.warn(`OCR unavailable (worker init failed): ${(err as Error).message}`);
    return results;
  }

  let recognized = 0;
  try {
    for (const url of batch) {
      try {
        const buf = await downloadImage(url);
        if (!buf) continue;
        const recognition = await Promise.race([
          worker.recognize(buf),
          new Promise<null>(resolve => setTimeout(() => resolve(null), PER_IMAGE_TIMEOUT_MS)),
        ]);
        if (!recognition) {
          logger.debug(`OCR timed out for ${url}`);
          continue;
        }
        const text = recognition.data.confidence >= MIN_CONFIDENCE
          ? tidy(recognition.data.text)
          : '';
        results.set(url, text);
        // Cache empty results too — "this image has no readable text" is a
        // real answer, and re-deriving it every poll is pure waste.
        await putCached(url, text);
        if (text) recognized++;
      } catch (err) {
        // Leave uncached so a transient failure retries on the next poll.
        logger.debug(`OCR failed for ${url}: ${(err as Error).message}`);
      }
    }
  } finally {
    try {
      await worker.terminate();
    } catch {
      // Worker teardown is best-effort.
    }
  }

  if (batch.length > 0) {
    logger.info(`OCR: processed ${batch.length} image(s), ${recognized} with text`);
  }
  return results;
}

/** Remove cache rows older than `ttlDays`, mirroring the other prune jobs. */
export async function pruneOldOCR(ttlDays: number): Promise<number> {
  const result = await query(
    `DELETE FROM image_ocr WHERE created_at < NOW() - INTERVAL '1 day' * $1`,
    [ttlDays]
  );
  return result.rowCount ?? 0;
}
