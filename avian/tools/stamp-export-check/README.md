# stamp-export-check

Visual gate for `avian/frontend/stamp-export.js`, the browser-side "download
this stamp as a PNG" feature. Local only — `avian/tools/` is never linked into
the webroot and the Caddy policy never serves it.

## Why it exists

The exporter hands the stamp back to the browser's own layout engine inside an
`<svg><foreignObject>` and rasterises the result. Whether that reproduces a
given design is not something you can settle by reading code: it depends on how
the rasteriser treats `mix-blend-mode`, CSS masks, container queries and SVG
patterns. So the harness renders all 29 designs live, exports each one, and puts
the PNG next to the DOM it came from, plus a difference blend of the two.

Every real defect so far was invisible to a GET-only smoke test and to
`node --check`:

1. **`rule.cssText` destroys any shorthand containing `var()`.** Chromium
   serialises `font:800 8px/1 var(--mono)` as every font longhand with an
   *empty* value. 17 of 559 rules came back gutted, including
   `.stamp,.stamp-fringe-outline` — the rule whose `background:var(--stamp-paper)`
   paints the paper and whose radial-gradient mask cuts the perforations. The
   exporter now reads the stylesheets as **raw text** and never touches the
   CSSOM for rule content.
2. **Swapping `<canvas>` for `<img>` drops tag-name CSS.** Three rules select
   the ink plate by tag (`.tpl-dither .dth-panel canvas`, the same for
   terraplana, and `canvas.fxc`). An `<img>` matches none of them, so the
   halftone plates lost `position:absolute;inset:0;width:100%;height:100%` and
   laid out at their intrinsic 825x900. The exporter now keeps the `<canvas>`
   and bakes the pixels on as its background.

3. **The designs depend on `styles.css`'s `* { box-sizing: border-box }`.**
   Without it `.stamp{padding:6px}` adds to the 188px width instead of
   insetting, `.face` is 188 wide instead of 176, and since every coordinate in
   these designs is a `cqw`, the whole interior renders ~7% oversized with the
   top line clipped. The exporter now pulls universal (`*`) rules from
   `styles.css` — never the whole file, which carries component rules that
   would fight the export.

   **This one is why the harness loads `styles.css` and asserts geometry.**
   The first version of this page did neither: it rendered the live stamp
   wrong in exactly the same way as the broken export, the two agreed, and it
   reported 29 clean while the live site was visibly wrong. A comparison
   harness that omits part of the real environment does not compare anything.

4. **The staging normalization CSS was not reaching the export.** It was
   injected into the page only, so the offscreen host laid out correctly and
   the SVG did not — the issue landed at (-13.5, -16.2), clipped, while every
   size still measured correct. One `NORMALIZE_CSS` constant now feeds both,
   and the gate asserts placement as well as size.

## Running it

Serve a webroot that mirrors what `scripts/link_webroot.sh` installs — the
templates use webroot-relative paths (`assets/stamp/...`,
`avian/assets/references/...`), so serving the repo root directly gives 404s
that are harness artifacts rather than export bugs:

```bash
W=$(mktemp -d); R=$PWD; F=$R/avian/frontend
cd "$W" && ln -sfn "$R/avian" avian
for f in styles.css stamps.css stamps.js stamp-batch-root.css stamp-batch-root.js \
         stamp-batch-a.css stamp-batch-a.js stamp-batch-b.css stamp-batch-b.js \
         stamp-batch-c.css stamp-batch-c.js stamp-batch-local.js stamp-export.js \
         grain.png stats-press.png fonts assets; do ln -sfn "$F/$f" "$f"; done
sed 's|/avian/frontend/|/|g' "$R/avian/tools/stamp-export-check/index.html" > export-check.html
python3 -m http.server 8732
```

Then open <http://localhost:8732/export-check.html> and press **Export all**.

## Reading the result

- The tally must say **28 clean, 0 with problems, 1 styleless**. A "problem"
  means an asset could not be embedded, or the export's geometry drifted from
  the live node. The styleless one is `field`, upstream's dead design — it is
  detected by the property (every face child `position:static`) rather than by
  name, so the next dead design is caught too.
- Each clean row also reports **geometry exact**: the real boxes inside the
  export document, measured in an iframe via `STAMP_EXPORT.toSvgText`, match
  the live node's to within 1px. A uniform scale error is invisible by eye —
  it has to be measured. Two traps live here: a check that *could not run* is
  reported as a failure, never a pass; and appending an iframe fires a `load`
  for `about:blank` before `srcdoc` applies, so the handler ignores any
  document that has no `<svg>` in it yet.
- Live and export panes are the same object at the same size, so they can be
  compared directly. The export carries a 2px transparent bleed for the
  dilated cut edge — that surround is expected.
- **The difference pane is not expected to be pure black.** Text edges glow
  from anti-aliasing, and the halftone designs (`dither`, `zurichpink`,
  `terraplana`, `flyRose`) light up across the whole plate because a 4-5x
  canvas resampled to 3x lands its dots on a different phase. That is
  resampling, not damage. What matters is a large *flat* bright region, which
  means a wrong colour, a missing element, or a shifted one.
- Thumbnails of fine dot screens moiré badly. Before believing a design has
  lost detail, view the live stamp at `transform:scale(3)` against the PNG at
  1:1 — `flyRose` looks washed out at thumbnail size and is pixel-faithful at
  full size.
- 28 of the 29 exports should have distinct file sizes. The single expected
  collision is `sparrowGuide` / `sparrowRosette`, which are parameter-identical
  by upstream's own design.
