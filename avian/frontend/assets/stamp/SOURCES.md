# Stamp reference assets

The two texture plates ship as `.webp` (see the note at the end); the `.png`
originals stay as the re-encode source and carry the attribution below.

- `owl-pale-treeline.jpg`: “Pale treeline,” Cole Patrick, CC0 1.0. Source: https://commons.wikimedia.org/wiki/File:Pale_treeline_(Unsplash).jpg
- `paper-texture-grey.png`: “Grey-paper,” Bawolff, public domain. Source: https://commons.wikimedia.org/wiki/File:Grey-paper.png
- `rough-concrete-cc0.png`: “Rough Concrete,” Dimitrios Savva / Poly Haven, CC0. Single full-bleed porous material plate used by the Icteridae issue. Source: https://polyhaven.com/a/rough_concrete
- `avian/assets/references/sparrow-blossom-single-v2.png` and `avian/assets/references/sparrow-blossom-pair-v2.png`: matched project-generated botanical plates, created together from the Sparrow reference's mid-century screen-print language. The single face-on blossom anchors the upper-left; the joined two-blossom stem resolves the lower-right text corner. Both are chroma-keyed alpha PNGs and receive the same live duotone/AM-screen renderer as the bird.

## WebP derivatives

`paper-texture-grey.webp` and `rough-concrete-cc0.webp` are what the stylesheets
actually load - the PNG originals were 3.4MB between them, against 229KB for the
pair. Same provenance and licence as the sources above.

Both were re-encoded at q=72 and downscaled (`rough-concrete-cc0` 1520px -> 960px,
`paper-texture-grey` 1024px -> 768px), which still leaves more than twice the
size either is rendered at - they composite as soft-light/multiply overlays at
opacity .16-.34 on a stamp face. Re-encode from the PNGs if a future layout ever
shows them larger; nothing regenerates these automatically, unlike the bird art.
