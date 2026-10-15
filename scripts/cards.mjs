/**
 * Regenerate `public/cards/*.png` from the public-domain source artwork.
 *
 *     bun scripts/cards.mjs            # rebuild every card
 *     bun scripts/cards.mjs QH AS      # rebuild two of them
 *
 * Not part of `bun run build`: the PNGs are committed, and this exists so the
 * deck can be re-derived (a different size, a re-trace of the source) instead of
 * being a folder of binaries nobody can account for. Needs `rsvg-convert`
 * (librsvg) and ImageMagick on PATH.
 *
 * On the three choices in here:
 *
 *  * **PNG, not the source SVG.** The court cards are traced engravings: 150 KB
 *    to 450 KB of path data each even after SVGO, ~3 MB for the twelve of them.
 *    Rasterised at 3x they are 25 KB. This is a phone game; the brief's "render
 *    cards as SVG or CSS" rule exists to keep the art licence-clean and crisp,
 *    and a public-domain deck at 3x device pixels is both. See AGENTS.md §7.
 *  * **3x of 88 px, the widest the UI ever draws a card.** Crisp on every phone
 *    in use, and one file per card rather than a `srcset` to keep in step.
 *  * **128 colours.** The art is flat fills and black linework, so a palette
 *    costs nothing visible and saves about two thirds of the bytes.
 */

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Pinned so the same command produces the same deck next year. */
const COMMIT = '861b338eb931d635c442b568071e3829e552f383';
const SOURCE = `https://raw.githubusercontent.com/notpeter/Vector-Playing-Cards/${COMMIT}/cards-svg`;

const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
/** Engine owns ids 52 and 53 for the jokers; the artwork calls them 1 and 2. */
const JOKERS = ['Joker1', 'Joker2'];

const WIDTH = 264; // 3 x 88px, the widest a card gets in the UI
const COLOURS = 128;
const OUT = new URL('../public/cards/', import.meta.url);

const ALL = [...SUITS.flatMap((suit) => RANKS.map((rank) => `${rank}${suit}`)), ...JOKERS];

const wanted = process.argv.slice(2);
const cards = wanted.length > 0 ? wanted : ALL;

await mkdir(OUT, { recursive: true });

let total = 0;
for (const name of cards) {
  if (!ALL.includes(name)) {
    console.error(`skip ${name}: not a card in this deck`);
    process.exitCode = 1;
    continue;
  }

  const response = await fetch(`${SOURCE}/${name}.svg`);
  if (!response.ok) {
    console.error(`skip ${name}: source returned ${response.status}`);
    process.exitCode = 1;
    continue;
  }

  const svg = new URL(`${name}.svg`, OUT);
  await writeFile(svg, Buffer.from(await response.arrayBuffer()));

  // White background: the artwork has rounded corners and the design system has
  // none, so the corners have to be filled or they show as notches.
  const png = new URL(`${name}.png`, OUT);
  await run('rsvg-convert', ['-w', String(WIDTH), '-b', 'white', svg.pathname, '-o', png.pathname]);
  await run('magick', [png.pathname, '-strip', '-colors', String(COLOURS), `PNG8:${png.pathname}`]);

  const { stdout } = await run('stat', ['-c', '%s', png.pathname]);
  total += Number(stdout.trim());
}

console.log(`${cards.length} cards, ${(total / 1024).toFixed(0)} KB total`);
