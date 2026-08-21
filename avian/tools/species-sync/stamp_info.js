#!/usr/bin/env node
/* ============================================================
   stamp_info.js - what the species-sync CMS needs to know about
   the Atlas stamp designs, dumped as JSON.

   The design catalogue is not data anywhere - it is ~29 template
   objects registered across stamps.js and four stamp-batch-*.js
   files, with the family map and the fallback pool held module-
   private inside stamps.js. Parsing that from Python would mean
   reimplementing styleFor(), which is exactly the drift that lets
   the CMS offer a design the page cannot actually draw.

   So this loads the real frontend under a DOM shim and asks it.
   Same technique as avian/tools/verify-stamps/verify-stamps.js;
   the shim is duplicated rather than shared because that script is
   a deploy gate and is deliberately standalone.

   Usage:
     node stamp_info.js                     # catalogue only
     node stamp_info.js "Genus species"     # + what that bird gets

   Exit 0 with JSON on stdout, 1 with {"error": ...}.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONTEND = path.resolve(__dirname, '../../frontend');

/* Shared by every design; they say nothing about whether an individual
   template has a stylesheet of its own. Kept in sync with verify-stamps. */
const GENERIC_CLASSES = new Set([
  'face', 'paper', 'vig', 'sil', 'fxc', 'bird', 'stamp', 'stamp-fit', 'no'
]);
const TAXON = /\b[A-Z]{4,}(?:IDAE|INAE|IFORMES)\b/;

function die(msg) {
  process.stdout.write(JSON.stringify({ error: String(msg) }));
  process.exit(1);
}

/* ---- Discover the real asset list from index.html, so this cannot
   drift out of sync with what the page actually loads. ---- */
function assetsFromIndex() {
  const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
  const grab = re => {
    const out = [];
    let m;
    while ((m = re.exec(html))) out.push(m[1]);
    return out;
  };
  return {
    js: grab(/<script\b[^>]*?\ssrc="\.\/((?:stamps|stamp-batch-[a-z]+)\.js)\?/g),
    css: grab(/<link rel="stylesheet" href="\.\/((?:stamps|stamp-batch-[a-z]+)\.css)\?/g)
  };
}

/* ---- Minimal DOM shim. The stamp modules touch document at load time
   but never need a real layout to BUILD markup - only to paint canvases,
   which we are not asking about. Proxies absorb whatever they reach for. ---- */
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
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Math, JSON, Date, String, Number, Array, Object, RegExp, Boolean, Error,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent
  }));
}

const assets = assetsFromIndex();
if (!assets.js.length) die('index.html declares no stamp scripts - the discovery regex has drifted.');

const ctx = buildContext();
for (const f of assets.js) {
  const p = path.join(FRONTEND, f);
  if (!fs.existsSync(p)) die(`${f} is referenced by index.html but missing from frontend/`);
  try {
    vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, { filename: f });
  } catch (e) {
    die(`${f} threw while loading: ${e.message}`);
  }
}

const S = ctx.window.STAMPS;
if (!S || !S.TPL) die('window.STAMPS never got built - the stamp system did not initialise.');

const css = assets.css
  .map(f => path.join(FRONTEND, f))
  .filter(fs.existsSync)
  .map(p => fs.readFileSync(p, 'utf8'))
  .join('\n');

function ownClasses(html) {
  const out = new Set();
  let m, re = /class="([^"{}]*)"/g;
  while ((m = re.exec(html))) {
    m[1].split(/\s+/).filter(Boolean).forEach(c => { if (!GENERIC_CLASSES.has(c)) out.add(c); });
  }
  return [...out];
}

/* A design is styleless when NONE of its own class names appear in any
   stylesheet. That is how upstream's retired 'field' blanked four species
   here, so the CMS must never offer one as a plain choice. */
function isStyleless(tpl) {
  const classes = ownClasses(tpl.html || '');
  if (!classes.length) return false;            // pure-SVG design, nothing to assert
  return !classes.some(c => css.includes('.' + c));
}

/* ORDERED_STYLES is module-private; probe pool membership through
   styleFor() with genera that cannot be in GENUS_GROUP. */
const POOL = (() => {
  const seen = new Set();
  for (let i = 0; i < 6000; i++) seen.add(S.styleFor('Zzgenus zz' + i).id);
  return seen;
})();
const ASSIGNED = new Set(Object.values(S.GROUP_STYLE || {}));

const sci = (process.argv[2] || '').trim();
const specimen = { sci: sci || 'Orthotomus sutorius', com: sci || 'Common Tailorbird', index: 7, count: 99 };
const family = sci ? S.familyOf(sci) : null;
const latin = sci ? (S.latinOf(sci) || '') : '';

const designs = Object.keys(S.TPL).sort().map(id => {
  const tpl = S.TPL[id];
  let rendered = '';
  try { rendered = S.markup(specimen, 'specimen.png', tpl); } catch (e) { rendered = ''; }

  // A hardcoded family name is correct for the family the design belongs to
  // and a lie on anybody else. Compare against this species' own family, so
  // 'raptor' stays offerable for an actual hawk.
  const taxon = (rendered.replace(/<[^>]*>/g, ' ').match(TAXON) || [null])[0];
  const falseTaxon = taxon && taxon.toUpperCase() !== String(latin).toUpperCase() ? taxon : null;

  const warnings = [];
  if (isStyleless(tpl)) {
    warnings.push('no stylesheet ships for this design - it renders as blank paper');
  }
  if (falseTaxon) {
    warnings.push('prints "' + falseTaxon + '" in the artwork, which is not this bird\'s family');
  }

  return {
    id: id,
    title: tpl.title || id,
    // {{SRC_ALT}} is always resolved to pose 2, so these designs cannot draw
    // a species that has no flight plate - the <img> breaks and the CSS-mask
    // shadow fails silently.
    needs_flight: String(tpl.html || '').indexOf('{{SRC_ALT}}') >= 0,
    family_assigned: ASSIGNED.has(id),
    in_fallback_pool: POOL.has(id),
    warnings: warnings
  };
});

const out = { designs: designs };

if (sci) {
  const cur = S.styleFor(sci);
  const groupStyle = family && S.GROUP_STYLE ? S.GROUP_STYLE[family] : null;
  out.species = {
    sci: sci,
    family: family,
    latin: latin,
    current: cur.id,
    // How the default was reached, so the CMS can say "this is its family
    // issue" rather than implying every bird was individually chosen.
    via: groupStyle && S.TPL[groupStyle] ? 'family' : 'hash',
    // markup() forces the flight plate for Columbidae regardless of which
    // design is picked, so this is a property of the bird, not the design.
    family_forces_flight: family === 'Doves & Pigeons'
  };
}

process.stdout.write(JSON.stringify(out));
