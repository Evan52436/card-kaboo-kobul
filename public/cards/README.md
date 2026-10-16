# Card faces

The 52 standard cards plus two jokers, named `rank` then `suit` — `AS.png`,
`10H.png`, `KD.png`, `Joker1.png`, `Joker2.png`. They map straight onto the
engine's own `rank`/`suit`, so nothing has to translate between the two.

**Every card exists twice: a `.webp` and a `.png`.** The app requests the WebP
and falls back to the PNG (`onError`), so a browser without WebP support shows
the card rather than a hole. The PNG is also the source of truth the WebP is
derived from — never edit a WebP by hand.

Rendered at 264 × 384 px (three times the largest card the UI draws, 88 px wide),
palette-quantised to 8-bit PNG. That is between 2 KB and 27 KB a card, 548 KB for
the whole deck, and a browser fetches only the cards actually on the table and
then caches them.

## The WebP step

The WebPs are **lossless**, not lossy. That is a measurement, not a preference:
these are flat, few-colour images, so PNG's palette is already close to optimal
and a lossy encoder has to spend bits on the ringing it introduces — the simple
cards came out *larger* than their PNGs (the seven of hearts: 5,772 B → 6,390 B
at q75). Lossless wins on all 54 cards, **548 KB → 452 KB, about 18% smaller**,
and it is **bit-exact**: `magick compare -metric AE` reports 0 differing pixels
on every card, with the dimensions preserved. `bun run cards:webp` does the
encoding and **fails** if any card comes out bigger than its PNG.

## Licence

**Public domain.** The artwork is *Vector Playing Cards* by **Byron Knoll**,
released into the public domain on Google Code, collected as SVG by **Peter
Tripp** in [notpeter/Vector-Playing-Cards][repo] and mirrored here as PNG. That
repository releases the images and their rendered output into the public domain,
or the WTFPL where public domain is not recognised. No attribution is required;
this file is here so nobody has to go and check.

[repo]: https://github.com/notpeter/Vector-Playing-Cards

## Regenerating

    bun run cards        # fetch the SVGs and rasterise to PNG
    bun run cards:webp   # re-encode every PNG to lossless WebP

`bun run cards` needs `rsvg-convert` (librsvg) and ImageMagick; `bun run cards:webp`
needs ImageMagick (or `cwebp`). Both are separate steps on purpose: the PNG is the
source and the WebP is derived, so a re-render must not be able to lose the
original. `bun run cards:webp` takes card names as arguments (`bun run cards:webp
7H AS`) to redo just those.

`bun run cards` pulls the SVGs from the commit pinned in the script, so the output
is reproducible rather than "whatever master was that day". The script is
documentation of provenance first and a build step second — neither is part of
`bun run build`, and both the PNGs and the WebPs are committed.
