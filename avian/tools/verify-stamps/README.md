# verify-stamps

Post-merge guard for the Atlas stamp system.

```bash
node avian/tools/verify-stamps/verify-stamps.js          # exit 0 clean, 1 regression
node avian/tools/verify-stamps/verify-stamps.js --verbose
```

No dependencies — plain Node, reads the frontend files directly.

## Why this exists

The two stamp regressions this fork has actually shipped both **fail
silently**: the page returns 200, the console stays clean, and only a human
looking at a stamp can tell something is wrong. A GET-only smoke test catches
neither. So this loads the real stamp modules under a DOM shim, renders every
registered design, and asserts on the resulting markup.

## What it checks

**1. The station wordmark.** Upstream bakes its own project name into ~20
template strings across five spellings that `{{PROJECT}}` never reaches. Our
rename lives in four `.replace()` calls at the end of `markup()`'s chain — one
hunk, easy to lose in a merge. If it goes, every stamp quietly reverts to
upstream's branding.

**2. Styleless designs.** A template whose CSS stops shipping still renders:
the cutout lays out at its natural size, overflows the 188px plate and is
clipped, leaving blank paper. This is exactly how upstream's retired `field`
design blanked 4 species here. The check is **generic** — it flags any template
none of whose own classes appear in any stylesheet — so it catches the next one
too, not just `field`.

**3. Reachability.** A styleless template nothing can select is dead weight,
not a bug. One that `styleFor()` can return *will* blank a species. Only the
latter fails the run; the former is reported as a note. `field` is currently
in that harmless state, and the check is what keeps it there.

The script discovers its file list from `index.html`'s own `<script>`/`<link>`
tags, so it cannot drift out of sync with what the page actually loads.

## After an upstream merge

Run it alongside `node --check`. A failure names the carry that was lost;
the full context for both lives under **Upstream sync state** in the
project's `CLAUDE.md`.

Verified to catch both regressions by reintroducing each one deliberately.
