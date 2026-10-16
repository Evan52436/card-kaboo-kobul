/**
 * Write `public/cards/*.webp` from the committed `public/cards/*.png`.
 *
 *     bun scripts/cards:webp.mjs          # convert every card
 *     bun scripts/cards:webp.mjs QH AS    # convert two of them
 *
 * Separate from `cards.mjs`, and deliberately so: that script needs the network
 * and `rsvg-convert` to redraw the deck, this one needs neither and runs against
 * whatever PNGs are on disk. Re-encoding, or converting a deck drawn by an older
 * version, must not require fetching the source artwork again.
 *
 * **The PNGs stay.** `Card.tsx` asks for the `.webp` and falls back to the `.png`
 * once (`fallToPng`) if it 404s, so a deck that has been drawn but not yet
 * encoded still shows cards rather than holes. That fallback is the reason both
 * formats are committed, and the browser downloads only the WebP — the PNGs cost
 * repo and deploy size, never a player's bandwidth.
 *
 * Encoding is lossless and the reason is measured, not stylistic: see the header
 * of `lib-webp.mjs`. Short version — the art is flat fills on a 128-colour
 * palette, so the obvious lossy encode came out **larger than the PNG** on most
 * cards, while lossless is smaller on all 54 and bit-exact.
 *
 * Not part of `bun run build`: the files are committed, like the PNGs.
 */

import { readdir } from 'node:fs/promises';
import { pathOf, sizeOf, toWebp } from './lib-webp.mjs';

const OUT = new URL('../public/cards/', import.meta.url);

const all = (await readdir(OUT))
  .filter((name) => name.endsWith('.png'))
  .map((name) => name.slice(0, -'.png'.length))
  .sort();

const wanted = process.argv.slice(2);
const cards = wanted.length > 0 ? wanted : all;

if (all.length === 0) {
  console.error('no PNGs in public/cards — run `bun run cards` first');
  process.exit(1);
}

let pngTotal = 0;
let webpTotal = 0;
const worse = [];

for (const name of cards) {
  if (!all.includes(name)) {
    console.error(`skip ${name}: no ${name}.png in public/cards`);
    process.exitCode = 1;
    continue;
  }

  const png = new URL(`${name}.png`, OUT);
  const webp = new URL(`${name}.webp`, OUT);
  await toWebp(pathOf(png), pathOf(webp));

  const before = await sizeOf(pathOf(png));
  const after = await sizeOf(pathOf(webp));
  if (before === null || after === null) {
    console.error(`skip ${name}: could not measure the result`);
    process.exitCode = 1;
    continue;
  }

  pngTotal += before;
  webpTotal += after;
  // Should never happen (see the header), so if it ever does it is a real
  // regression in the encoding rather than noise — say so and fail.
  if (after > before) worse.push(`${name} (${before} → ${after})`);
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const saved = pngTotal > 0 ? (100 - (webpTotal * 100) / pngTotal).toFixed(0) : '0';
console.log(`${cards.length} cards: ${kb(pngTotal)} png → ${kb(webpTotal)} webp (${saved}% smaller)`);

if (worse.length > 0) {
  console.error(`\n${worse.length} card(s) came out LARGER than their PNG:`);
  for (const line of worse) console.error(`  ${line}`);
  console.error('Lossless should always win on this art — check the encoder, not the art.');
  process.exitCode = 1;
}
