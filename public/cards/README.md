# Card faces

The 52 standard cards plus two jokers, named `rank` then `suit` — `AS.png`,
`10H.png`, `KD.png`, `Joker1.png`, `Joker2.png`. They map straight onto the
engine's own `rank`/`suit`, so nothing has to translate between the two.

Rendered at 264 × 384 px (three times the largest card the UI draws, 88 px wide),
palette-quantised to 8-bit PNG. That is between 2 KB and 27 KB a card, 668 KB for
the whole deck, and a browser fetches only the cards actually on the table and
then caches them.

## Licence

**Public domain.** The artwork is *Vector Playing Cards* by **Byron Knoll**,
released into the public domain on Google Code, collected as SVG by **Peter
Tripp** in [notpeter/Vector-Playing-Cards][repo] and mirrored here as PNG. That
repository releases the images and their rendered output into the public domain,
or the WTFPL where public domain is not recognised. No attribution is required;
this file is here so nobody has to go and check.

[repo]: https://github.com/notpeter/Vector-Playing-Cards

## Regenerating

    bun scripts/cards.mjs

Needs `rsvg-convert` (librsvg) and ImageMagick. It pulls the SVGs from the commit
pinned in the script, so the output is reproducible rather than "whatever master
was that day". The script is documentation of provenance first and a build step
second — it is not part of `bun run build`, and the PNGs are committed.
