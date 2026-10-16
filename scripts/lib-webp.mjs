import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Resolve a `file:` URL to a real filesystem path.
 *
 * **Never pass `url.pathname` to a child process.** `pathname` is
 * percent-ENCODED: a checkout under `/home/me/My Projects/kobul` hands
 * ImageMagick the literal string `My%20Projects`, which it cannot open, and the
 * failure reads as "the encoder is missing" rather than "the path is wrong".
 * `fileURLToPath` decodes it. This bit both card scripts (AGENTS.md §9).
 */
export const pathOf = (url) => fileURLToPath(url);

/**
 * Write `dst` as a **lossless** WebP of `src`.
 *
 * Lossless is a measurement, not a taste. The source art is flat fills, a
 * handful of colours and hard black linework, and the PNGs are already `PNG8`
 * with a 128-colour palette — which is very close to optimal for that. Encoding
 * the same files the obvious way (lossy, `-quality 82`) made **most of them
 * bigger than the PNG they came from**: 7H went 5772 → 7748 bytes, and only the
 * engraved court cards gained at all. Lossy compression has to spend bits
 * describing the ringing it just introduced on flat colour, and there was
 * nothing for it to throw away that the palette had not already removed.
 *
 * Lossless, by contrast, is smaller than the PNG on **every one of the 54**
 * cards — 548 KB → 452 KB, no card worse — and it is bit-exact, so the art
 * cannot acquire artefacts on the engraved court cards, and "did the conversion
 * work" is a test rather than an opinion. See AGENTS.md §7.
 *
 * `method=6` is libwebp's slowest and smallest search; this runs once per deck,
 * so the seconds are free.
 *
 * ImageMagick first, because `cards.mjs` already needs it and an Arch install
 * builds it with libwebp 1.6; `cwebp` (the `libwebp` package) second, for a
 * machine whose ImageMagick has no WebP encoder.
 */
export async function toWebp(src, dst) {
  try {
    await run('magick', [src, '-strip', '-define', 'webp:lossless=true', '-define', 'webp:method=6', dst]);
    return;
  } catch (magickError) {
    try {
      await run('cwebp', ['-quiet', '-lossless', '-m', '6', src, '-o', dst]);
    } catch {
      const why = String(magickError?.message ?? magickError).split('\n')[0];
      throw new Error(`could not write ${dst}: ImageMagick failed (${why}) and cwebp is not installed`);
    }
  }
}

/** Byte size of a file, or `null` if it is not there. */
export async function sizeOf(path) {
  try {
    const { stdout } = await run('stat', ['-c', '%s', path]);
    return Number(stdout.trim());
  } catch {
    return null;
  }
}
