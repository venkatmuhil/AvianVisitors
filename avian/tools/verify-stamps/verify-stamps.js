#!/usr/bin/env node
/* ============================================================
   verify-stamps.js - post-merge guard for the Atlas stamp system.

   Two regressions this fork has actually shipped both fail SILENTLY:
   the page returns 200, the console stays clean, and only a human
   looking at a stamp can tell. A GET-only smoke test catches neither.
   So this renders every registered design in Node under a DOM shim
   and asserts on the markup itself.

     1. WORDMARK  - upstream bakes its own project name into ~20
        template strings across five spellings that {{PROJECT}} never
        reaches. Our rename lives in markup()'s replace chain; a merge
        that drops those lines silently restores upstream's branding.

     2. STYLELESS DESIGN - a template whose CSS stopped shipping still
        renders: the cutout lays out at its natural size, overflows the
        188px plate and is clipped, leaving blank paper. This is how
        upstream's retired 'field' design blanked 4 species here. The
        check is deliberately GENERIC, so it catches the next one too,
        not just 'field'.

     3. FALSE TAXONOMY - a few family issues hardcode their own family
        name in the artwork ('raptor' prints ACCIPITRIDAE). Those are
        correct for the family they are assigned to and WRONG for anyone
        else, so they must never enter the unknown-genus fallback pool.
        A wrong stamp is worse than a plain one, and nothing about it
        looks broken.

   Usage:  node avian/tools/verify-stamps/verify-stamps.js [--verbose]
   Exit 0 = clean, 1 = regression. Safe to wire into CI or a deploy gate.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONTEND = path.resolve(__dirname, '../../frontend');
const VERBOSE = process.argv.includes('--verbose');

/* The station's own wordmark. Update both if the station is ever renamed
   again; the OLD list is what we assert has been fully displaced. */
const WORDMARK = /Karwar ?Birdie|KARWAR ?BIRDIE/;
const UPSTREAM_WORDMARK = /Avian ?Visitors|AVIAN ?VISITORS/;

/* Classes shared by every design; they say nothing about whether an
   individual template has a stylesheet of its own. */
const GENERIC_CLASSES = new Set([
  'face', 'paper', 'vig', 'sil', 'fxc', 'bird', 'stamp', 'stamp-fit', 'no'
]);

let failures = [];
let notes = [];
const fail = m => failures.push(m);
const note = m => notes.push(m);

/* ---- Discover the real asset list from index.html, so this script
   cannot drift out of sync with what the page actually loads. ---- */
function assetsFromIndex() {
  const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
  const grab = re => {
    const out = [];
    let m;
    while ((m = re.exec(html))) out.push(m[1]);
    return out;
  };
  // Tolerate attributes between <script and src= (the bundles carry defer),
  // so adding one does not read as "the stamp system vanished".
  const js = grab(/<script\b[^>]*?\ssrc="\.\/((?:stamps|stamp-batch-[a-z]+)\.js)\?/g);
  const css = grab(/<link rel="stylesheet" href="\.\/((?:stamps|stamp-batch-[a-z]+)\.css)\?/g);
  return { js, css, html };
}

/* ---- Minimal DOM shim. The stamp modules touch document at load time
   (stage attributes, filter injection, IntersectionObserver) but never
   need a real layout to BUILD markup - only to paint canvases, which we
   are not asserting on. Proxies absorb whatever they reach for. ---- */
function buildContext() {
  const el = () => new Proxy(function () {}, {
    get: (t, k) => {
      if (k === 'style') return el();
      if (k === 'classList') return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (k === 'dataset') return {};
      if (k === 'children' || k === 'childNodes') return [];
      if (typeof k === 'symbol') return undefined;
      return el();
    },
    set: () => true,
    apply: () => el()
  });
  const doc = new Proxy({}, {
    get: (t, k) => {
      if (['querySelectorAll', 'getElementsByClassName', 'getElementsByTagName'].includes(k)) return () => [];
      if (['documentElement', 'head', 'body'].includes(k)) return el();
      if (typeof k === 'symbol') return undefined;
      return () => el();
    }
  });
  const win = {
    document: doc,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {},
    navigator: { userAgent: 'node' },
    location: { search: '', href: '' },
    IntersectionObserver: function () { this.observe = () => {}; this.unobserve = () => {}; this.disconnect = () => {}; },
    ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    Image: function () {},
    HTMLElement: function () {}
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;
  return vm.createContext(Object.assign(win, {
    console: VERBOSE ? console : { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Math, JSON, Date, String, Number, Array, Object, RegExp, Boolean, Error,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent
  }));
}

/* ---- Load the stamp system ---- */
const assets = assetsFromIndex();
if (!assets.js.length) fail('index.html declares no stamp scripts - the discovery regex has drifted.');

const ctx = buildContext();
for (const f of assets.js) {
  const p = path.join(FRONTEND, f);
  if (!fs.existsSync(p)) { fail(`${f} is referenced by index.html but missing from frontend/.`); continue; }
  try {
    vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, { filename: f });
  } catch (e) {
    fail(`${f} threw while loading: ${e.message}`);
  }
}

const S = ctx.window.STAMPS;
if (!S || !S.TPL) {
  fail('window.STAMPS never got built - the stamp system did not initialise.');
  report();
}

const ids = Object.keys(S.TPL);
note(`loaded ${assets.js.length} scripts, ${assets.css.length} stylesheets, ${ids.length} templates`);

/* ---- Render every design once ---- */
const SPECIMEN = { sci: 'Orthotomus sutorius', com: 'Common Tailorbird', index: 7, count: 99 };
const rendered = {};
for (const id of ids) {
  try {
    rendered[id] = S.markup(SPECIMEN, 'specimen.png', S.TPL[id]);
  } catch (e) {
    fail(`template '${id}' threw while rendering: ${e.message}`);
  }
}

/* ---- CHECK 1: the wordmark ---- */
const stale = ids.filter(id => rendered[id] && UPSTREAM_WORDMARK.test(rendered[id]));
const marked = ids.filter(id => rendered[id] && WORDMARK.test(rendered[id]));
if (stale.length) {
  fail(`${stale.length} template(s) still print upstream's wordmark - the rename carry in markup() was lost: ${stale.join(', ')}`);
} else {
  note(`wordmark: 0 templates print upstream's name; ${marked.length}/${ids.length} print the station's`);
}

/* ---- CHECK 2: every reachable design has a stylesheet ----
   A template is "styleless" when NONE of its own class names appear in
   any stylesheet. Generic classes are excluded, since they are defined
   once for all designs and would mask a missing per-design sheet. */
const css = assets.css
  .map(f => path.join(FRONTEND, f))
  .filter(fs.existsSync)
  .map(p => fs.readFileSync(p, 'utf8'))
  .join('\n');

function ownClasses(html) {
  const out = new Set();
  let m, re = /class="([^"{}]*)"/g;
  while ((m = re.exec(html))) {
    m[1].split(/\s+/).filter(Boolean).forEach(c => {
      if (!GENERIC_CLASSES.has(c)) out.add(c);
    });
  }
  return [...out];
}

const styleless = [];
for (const id of ids) {
  const classes = ownClasses(S.TPL[id].html || '');
  if (!classes.length) continue;                       // pure-SVG design, nothing to assert
  const styled = classes.filter(c => css.includes('.' + c));
  if (!styled.length) styleless.push({ id, classes });
  else if (VERBOSE) note(`  ${id}: ${styled.length}/${classes.length} classes styled`);
}

/* ---- CHECK 3: is anything styleless actually reachable? ----
   A styleless template that nothing can select is dead weight, not a
   bug. One that styleFor() can return WILL blank a species. */
/* ORDERED_STYLES is module-private, so pool membership is probed through
   styleFor(): an unknown genus hashes across exactly that pool. This MUST
   stay independent of GROUP_STYLE - a design can be both family-assigned
   and pooled (flock, geo, mono, kieler, linescreen and opart all are), and
   an earlier version of this script returned 'GROUP_STYLE' first and so
   never checked those, which is precisely the set CHECK 4 cares about. */
const POOL = (() => {
  const seen = new Set();
  for (let i = 0; i < 6000; i++) seen.add(S.styleFor('Zzgenus zz' + i).id);
  return seen;
})();
const assigned = new Set(Object.values(S.GROUP_STYLE || {}));

function reachable(id) {
  const via = [];
  if (assigned.has(id)) via.push('GROUP_STYLE');
  if (POOL.has(id)) via.push('unknown-genus fallback pool');
  return via.length ? via.join(' + ') : null;
}

for (const { id, classes } of styleless) {
  const via = reachable(id);
  const detail = `template '${id}' has no CSS for any of its ${classes.length} classes (${classes.slice(0, 4).join(', ')}${classes.length > 4 ? ', ...' : ''})`;
  if (via) fail(`${detail} - and it IS reachable via ${via}, so a species will render blank paper.`);
  else note(`${detail} - unreachable, so harmless; leave it out of the selection pools.`);
}
if (!styleless.length) note(`stylesheets: all ${ids.length} templates have CSS of their own`);

/* ---- CHECK 4: nothing in the generic pool asserts a family ----
   Family-assigned designs may double as fallbacks - flock, geo, mono,
   kieler, linescreen and opart all do - but only if their artwork makes
   no taxonomic claim of its own. */
const TAXON = /\b[A-Z]{4,}(?:IDAE|INAE|IFORMES)\b/;
const pooled = ids.filter(id => POOL.has(id));
let lying = 0;
for (const id of pooled) {
  const m = (rendered[id] || '').replace(/<[^>]*>/g, ' ').match(TAXON);
  if (m) {
    lying++;
    fail(`template '${id}' hardcodes the taxon '${m[0]}' but sits in the unknown-genus fallback pool - it will print a false family on unrelated species.`);
  }
}
if (!lying) note(`taxonomy: none of the ${pooled.length} pooled designs hardcode a family name`);

/* ---- CHECK 5: the GENUS_GROUP export carry + local batch ----
   Local carry #5 puts GENUS_GROUP on window.STAMPS so stamp-batch-local.js
   (generated by avian/tools/genus-groups/build_batch.py) can widen the
   genus->family map. Lose the carry and the batch goes inert SILENTLY:
   every non-upstream genus falls back to the hash pool. Upstream alone
   carries ~126 genera; the widened map carries 400+. */
const GG = S.GENUS_GROUP;
if (!GG) {
  fail("S.GENUS_GROUP is not exported - stamps.js carry #5 was lost, so stamp-batch-local.js is inert and every non-upstream genus silently falls back to the hash pool.");
} else {
  const n = Object.keys(GG).length;
  if (n < 400) fail(`GENUS_GROUP has only ${n} genera (expected 400+) - stamp-batch-local.js did not apply (missing script tag, load-order change, or a lost carry).`);
  else note(`genus map: ${n} genera mapped (upstream + local batch)`);
}

const stylelessIds = new Set(styleless.map(s => s.id));

/* ---- CHECK 6: mapping closure ----
   styleFor() guards with TPL[GROUP_STYLE[g]] and silently falls through to
   the hash on a typo'd design id, and latinOf() returns '' for a group
   missing from GROUP_LATIN (blank Latin line + display name leaking into
   the species modal). Neither failure has any runtime signal. */
if (GG) {
  const badStyle = [], badLatin = [], blankStyle = [];
  for (const group of new Set(Object.values(GG))) {
    const styleId = (S.GROUP_STYLE || {})[group];
    if (!styleId || !S.TPL[styleId]) badStyle.push(`${group} -> ${styleId || '(none)'}`);
    else if (stylelessIds.has(styleId)) blankStyle.push(`${group} -> ${styleId}`);
    if (!(S.GROUP_LATIN || {})[group]) badLatin.push(group);
  }
  if (badStyle.length) fail(`group(s) whose GROUP_STYLE names no existing template (silent hash fallthrough): ${badStyle.join('; ')}`);
  if (blankStyle.length) fail(`group(s) assigned a STYLELESS template (members render blank paper): ${blankStyle.join('; ')}`);
  if (badLatin.length) fail(`group(s) missing from GROUP_LATIN (empty Latin line, display name leaks into the modal): ${badLatin.join(', ')}`);
  if (!badStyle.length && !blankStyle.length && !badLatin.length) note('mapping closure: every group has a styled template and a Latin name');
}

/* ---- Load dims.json once for CHECKs 7 and 9 ---- */
const DIMS = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'dims.json'), 'utf8'));
const baseSlugs = Object.keys(DIMS).filter(k => !k.endsWith('-2'));

/* ---- CHECK 7: the flight-plate rule ----
   Two things force the pose-2 plate: a template whose html carries
   {{SRC_ALT}} (markup() resolves it to pose 2 unconditionally), and the
   'Doves & Pigeons' family hardcode in markup(). A species in such a group
   without a '-2' entry renders blank paper with a clean console. */
if (GG) {
  const flightGroups = new Set(['Doves & Pigeons']);
  for (const group of new Set(Object.values(GG))) {
    const styleId = (S.GROUP_STYLE || {})[group];
    const tpl = styleId && S.TPL[styleId];
    if (tpl && String(tpl.html || '').includes('{{SRC_ALT}}')) flightGroups.add(group);
  }
  const flightMissing = [];
  for (const slug of baseSlugs) {
    const genus = slug.split('-')[0];
    const cap = genus.charAt(0).toUpperCase() + genus.slice(1);
    if (flightGroups.has(GG[cap]) && !DIMS[slug + '-2']) flightMissing.push(`${slug} (${GG[cap]})`);
  }
  if (flightMissing.length) {
    fail(`${flightMissing.length} species sit in a flight-composed group without a '-2' plate and will render blank paper: ${flightMissing.slice(0, 8).join(', ')}${flightMissing.length > 8 ? ', ...' : ''}`);
  } else {
    note(`flight rule: every species in a flight-composed group (${[...flightGroups].join(', ')}) has a -2 plate`);
  }
}

/* ---- CHECK 8: per-group taxon honesty ----
   CHECK 4 covers the hash pool; this covers family assignments. A design
   that bakes its own family into the artwork (raptor prints ACCIPITRIDAE)
   is only honest for groups whose GROUP_LATIN matches it exactly. Raw
   template html is scanned so an injected {{ORDER}} cannot false-positive. */
if (GG) {
  let dishonest = 0;
  for (const group of new Set(Object.values(GG))) {
    const styleId = (S.GROUP_STYLE || {})[group];
    const tpl = styleId && S.TPL[styleId];
    if (!tpl) continue;
    const m = String(tpl.html || '').replace(/<[^>]*>/g, ' ').match(TAXON);
    if (m && m[0] !== String((S.GROUP_LATIN || {})[group] || '').toUpperCase()) {
      dishonest++;
      fail(`group '${group}' uses design '${styleId}' which hardcodes '${m[0]}', but the group's Latin family is '${(S.GROUP_LATIN || {})[group] || '(none)'}'.`);
    }
  }
  if (!dishonest) note('group taxonomy: no family assignment prints a taxon that contradicts its GROUP_LATIN');
}

/* ---- CHECK 9: full sweep over every species with art ----
   Reconstruct the binomial from each base slug (all slugs are exactly
   genus-epithet), run the real styleFor(), and require a styled template
   AND a genus-mapped (non-hash) resolution. This is the "new art must be
   mapped" deploy gate: add a cutout, and this fails until the genus gets
   a group in avian/tools/genus-groups/group-plan.json. */
if (GG) {
  const hashed = [], blank = [];
  for (const slug of baseSlugs) {
    const parts = slug.split('-');
    const sci = parts[0].charAt(0).toUpperCase() + parts[0].slice(1) + ' ' + parts.slice(1).join('-');
    if (!GG[sci.split(' ')[0]]) hashed.push(slug);
    const t = S.styleFor(sci);
    if (t && stylelessIds.has(t.id)) blank.push(`${slug} -> ${t.id}`);
  }
  if (hashed.length) fail(`${hashed.length}/${baseSlugs.length} species with art resolve by hash, not family - add their genera to group-plan.json and re-run build_batch.py: ${hashed.slice(0, 8).join(', ')}${hashed.length > 8 ? ', ...' : ''}`);
  if (blank.length) fail(`species resolving to a styleless template: ${blank.slice(0, 8).join(', ')}`);
  if (!hashed.length && !blank.length) note(`full sweep: ${baseSlugs.length}/${baseSlugs.length} species resolve via a family issue, 0 via hash`);
}

report();

function report() {
  const line = '-'.repeat(64);
  console.log(line);
  console.log('verify-stamps');
  console.log(line);
  notes.forEach(n => console.log('  ' + n));
  if (failures.length) {
    console.log('');
    failures.forEach(f => console.log('  FAIL  ' + f));
    console.log('');
    console.log(`${failures.length} regression(s). See the stamps.js carries in CLAUDE.md.`);
    process.exit(1);
  }
  console.log('');
  console.log('  OK - no stamp regressions.');
  process.exit(0);
}
