/* ============================================================
   stamp-export.js - download the open postcard's issue as a PNG.

   FORK-OWNED. Upstream AvianVisitors does not ship this file, so it can
   never conflict on a merge. Everything it needs it reads through public
   surfaces - window.STAMPS, the live DOM, and the page's own stylesheets -
   so stamps.js and apt.js stay untouched and the export keeps working
   against whatever designs upstream adds next.

   The rasterisation is entirely client-side. Nothing is generated on the
   Pi: no endpoint, no PHP, no temp files. The whole cost is one click's
   worth of work in the tab that asked for it.

   How it works
   ------------
   A stamp is not an image - it is DOM: a perforation-masked <figure>, a
   dilated silhouette that draws the cut edge, CSS-mask bird shapes, inline
   SVG, oversampled <canvas> ink plates and eighteen webfonts. The only way
   to turn that into a bitmap in-browser is to hand it back to the browser's
   own layout engine inside an <svg><foreignObject>, then draw the resulting
   image into a canvas.

   An SVG loaded into an <img> is sandboxed: it cannot fetch ANYTHING. So
   every external reference has to travel inside the document -

     fonts      @font-face src -> data: URI  (only the families actually used)
     bird art   <img src>, SVG <image href>  -> data: URI
     textures   grain/press/paper url()      -> data: URI
     ink plates <canvas> pixels -> <img src=toDataURL()>
     filters    #stampFringe*, #duo-*, #poster defs copied in verbatim

   - and the stylesheets have to come along as text, because 43 of these
   designs are drawn with ::before/::after and no computed-style walk can
   reach a pseudo-element.

   Two subtleties worth keeping if this is ever rewritten:

   1. Media queries are resolved against the REAL window before the CSS is
      embedded, not left for the SVG to evaluate. The SVG's own viewport is
      the size of one stamp, so `@media (max-width:700px)` would otherwise
      fire on a desktop export and quietly hand back the phone layout.
   2. `:root` is rewritten to the export root and the effective theme is
      pinned as an attribute, because inside a foreignObject there is no
      document element for `:root` to match and `prefers-color-scheme` is
      not reliably inherited from the host page.
   ============================================================ */
(function () {
  'use strict';

  var SCALE = 3;                     // 188px issue -> ~564px PNG
  var BLEED = 2;                     // px of transparent margin for the dilated cut edge
  var XHTML = 'http://www.w3.org/1999/xhtml';

  /* ---------- asset inlining ------------------------------------------ */

  var assetMemo = Object.create(null);
  var lastFailures = [];

  function asDataUri(url) {
    if (assetMemo[url]) return assetMemo[url];
    var p = fetch(url, { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      })
      .then(function (blob) {
        return new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onload = function () { resolve(String(reader.result)); };
          reader.onerror = function () { reject(new Error('read')); };
          reader.readAsDataURL(blob);
        });
      })
      .catch(function (err) {
        /* A missing asset must not abort the whole export - the rest of the
           issue is still worth having. But it must not vanish either: a
           silently-dropped texture is exactly the failure mode this repo
           keeps getting bitten by, so record it and report at the end. */
        lastFailures.push(url + ' (' + (err && err.message || err) + ')');
        return '';
      });
    assetMemo[url] = p;
    return p;
  }

  var URL_RE = /url\((['"]?)([^'")]+)\1\)/g;

  /* Each distinct asset is embedded ONCE, as a custom property on the export
     root, and every reference becomes var(--sx-aN).

     The stylesheet describes all 29 designs, so a texture like grain.png is
     named by many rules - most belonging to designs this stamp is not. Pasting
     the data URI at each site produced 65 embeds totalling 7.1MB for a single
     stamp, and Chromium silently refuses to rasterise an SVG image that large:
     the <img> fires onload, reports the right intrinsic size, and paints
     nothing, so the export comes back fully transparent with no error anywhere.

     Fonts are the exception and stay literal - custom properties do not resolve
     inside @font-face, which has no element to inherit from. Each face appears
     once regardless. */
  var assetVars = Object.create(null);
  var assetVarSeq = 0;

  function registerAsset(raw, dataUri) {
    if (/^data:font\//i.test(dataUri)) return null;      // @font-face: literal only
    if (!assetVars[raw]) {
      assetVars[raw] = { name: '--sx-a' + (assetVarSeq++), uri: dataUri };
    }
    return assetVars[raw].name;
  }

  /* Emit definitions for exactly the vars the finished document references. */
  function assetPrelude(documentText) {
    var out = [];
    Object.keys(assetVars).forEach(function (raw) {
      var entry = assetVars[raw];
      if (documentText.indexOf('var(' + entry.name + ')') >= 0) {
        out.push(entry.name + ':url("' + entry.uri + '")');
      }
    });
    return out.length ? '.sx-root{' + out.join(';') + '}' : '';
  }

  /* Rewrite every fetchable url() to a data: URI, or to the var that holds it.
     Fragment references (url(#stampFringeLight)) are left alone - those
     resolve against the defs we copy into the export SVG. */
  function inlineCssUrls(css) {
    var wanted = [];
    css.replace(URL_RE, function (match, quote, raw) {
      if (/^data:/i.test(raw) || raw.charAt(0) === '#') return match;
      if (wanted.indexOf(raw) < 0) wanted.push(raw);
      return match;
    });
    if (!wanted.length) return Promise.resolve(css);
    return Promise.all(wanted.map(asDataUri)).then(function (results) {
      var map = Object.create(null);
      wanted.forEach(function (raw, i) { if (results[i]) map[raw] = results[i]; });
      return css.replace(URL_RE, function (match, quote, raw) {
        var uri = map[raw];
        if (!uri) return match;
        var name = registerAsset(raw, uri);
        return name ? 'var(' + name + ')' : 'url("' + uri + '")';
      });
    });
  }

  /* ---------- stylesheet collection ----------------------------------- */

  function isStampSheet(href) {
    return /\/stamps\.css(\?|$)/.test(href) ||
           /\/stamp-batch-[a-z]+\.css(\?|$)/.test(href);
  }

  /* styles.css is the page's own stylesheet and must NOT be embedded wholesale
     - it carries `.postcard-stamp-slot .stamp-fit{...!important}` and other
       component rules that would fight the export's geometry.
     But the stamp designs do depend on one thing in it: the universal
     `* { box-sizing: border-box }` reset. Without it `.stamp{padding:6px}`
     adds to the 188px width instead of insetting, `.face` comes out 188 wide
     instead of 176, and since every dither/flock/geo coordinate is expressed
     in `cqw`, the entire interior renders ~7% oversized and the top line is
     clipped away. That is small enough to look fine in a thumbnail, which is
     exactly why it has to be taken from the page rather than assumed.
     Universal rules only: a selector made of nothing but `*` can never carry
     component styling in. */
  function isPageSheet(href) {
    return /\/styles\.css(\?|$)/.test(href);
  }

  function isUniversalSelector(selector) {
    var parts = String(selector).split(',');
    for (var i = 0; i < parts.length; i++) {
      if (!/^\s*\*(::?[a-z-]+)?\s*$/i.test(parts[i])) return false;
    }
    return parts.length > 0;
  }

  function sheetHrefs(match) {
    return [].slice.call(document.styleSheets)
      .map(function (sheet) { return sheet.href || ''; })
      .filter(match);
  }

  function stampSheetHrefs() { return sheetHrefs(isStampSheet); }

  /* The stylesheets are fetched as TEXT, deliberately - NOT read out of the
     CSSOM as rule.cssText.

     Chromium cannot serialize a shorthand whose value contains var(). Asked
     for `font:800 8px/1 var(--mono)` it hands back every font longhand with
     an EMPTY value, which destroys the declaration outright. Measured on this
     stylesheet: 17 of 559 rules come back gutted, and they are not obscure
     ones - the casualties include `.stamp,.stamp-fringe-outline`, whose
     `background:var(--stamp-paper)` paints the paper and whose radial-gradient
     mask cuts the perforations, plus `mask:var(--src)` on the silhouette
     birds. The damage is silent: the CSS still parses, so the export simply
     comes back subtly wrong.

     Raw text has none of that problem. The cost is that @media has to be
     resolved by hand (below) and relative url()s made absolute. */
  var sheetTextMemo = Object.create(null);

  function sheetText(href) {
    if (sheetTextMemo[href]) return sheetTextMemo[href];
    var p = fetch(href, { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (text) { return absolutiseUrls(stripComments(text), href); })
      .catch(function (err) {
        lastFailures.push('stylesheet ' + href + ' (' + (err && err.message || err) + ')');
        return '';
      });
    sheetTextMemo[href] = p;
    return p;
  }

  function absolutiseUrls(css, base) {
    return css.replace(URL_RE, function (match, quote, raw) {
      if (/^data:/i.test(raw) || raw.charAt(0) === '#') return match;
      try { return 'url("' + new URL(raw, base).href + '")'; }
      catch (e) { return match; }
    });
  }

  /* --- a small CSS scanner, string- and comment-aware --- */

  function skipString(css, i) {
    var quote = css.charAt(i);
    for (i++; i < css.length; i++) {
      if (css.charAt(i) === '\\') { i++; continue; }
      if (css.charAt(i) === quote) return i;
    }
    return css.length - 1;
  }

  function matchBrace(css, open) {
    var depth = 0;
    for (var i = open; i < css.length; i++) {
      var c = css.charAt(i);
      if (c === '/' && css.charAt(i + 1) === '*') {
        var close = css.indexOf('*/', i + 2);
        i = close < 0 ? css.length : close + 1;
        continue;
      }
      if (c === '"' || c === "'") { i = skipString(css, i); continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (!depth) return i; }
    }
    return css.length - 1;
  }

  /* Comments are stripped before anything reads the text. stamps.css documents
     the silhouette convention with a literal `url('CUTOUT')` inside a comment,
     and the url() rewriter would otherwise dutifully try to fetch a file
     called CUTOUT and report a 404 on every export. */
  function stripComments(css) {
    var out = '', i = 0, n = css.length;
    while (i < n) {
      var c = css.charAt(i);
      if (c === '/' && css.charAt(i + 1) === '*') {
        var close = css.indexOf('*/', i + 2);
        i = close < 0 ? n : close + 2;
        continue;
      }
      if (c === '"' || c === "'") {
        var end = skipString(css, i);
        out += css.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

  /* Resolve @media against the REAL window and splice the matching blocks in
     where they stood, so source order - and therefore which override wins -
     is unchanged. This has to happen here rather than being left to the SVG:
     the SVG's own viewport is one stamp wide, so `@media (max-width:700px)`
     would fire on a desktop export and hand back the phone layout. */
  function processCss(css, keepFace, keepSelector) {
    var out = '', i = 0, n = css.length;
    while (i < n) {
      var ch = css.charAt(i);
      /* Whitespace has to be consumed here, before the dispatch below.
         Without this, a newline ahead of `@font-face` or `@media` fell through
         to the ordinary-rule branch, which scans forward to the next `{` and
         emits everything up to its matching `}` verbatim - swallowing the
         at-rule whole. The effect was silent and doubled: no @font-face was
         ever filtered (all 17 faces shipped, ~1MB per export instead of ~200KB)
         and no @media was ever resolved, so mobile blocks were left for the SVG
         to evaluate against its own one-stamp-wide viewport. */
      if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f') {
        i++;
        continue;
      }
      if (ch === '/' && css.charAt(i + 1) === '*') {
        var ce = css.indexOf('*/', i + 2);
        i = ce < 0 ? n : ce + 2;
        continue;
      }
      if (ch === '@') {
        var kw = (/^@([a-zA-Z-]+)/.exec(css.slice(i, i + 32)) || [])[1];
        if (kw) {
          kw = kw.toLowerCase();
          var stop = -1;
          for (var j = i; j < n; j++) {
            var c = css.charAt(j);
            if (c === '"' || c === "'") { j = skipString(css, j); continue; }
            if (c === '{' || c === ';') { stop = j; break; }
          }
          if (stop < 0) { out += css.slice(i); break; }
          if (css.charAt(stop) === ';') { i = stop + 1; continue; }  // @import/@charset: drop
          var close = matchBrace(css, stop);
          var prelude = css.slice(i, stop).trim();
          var inner = css.slice(stop + 1, close);
          if (kw === 'media') {
            var cond = prelude.replace(/^@media\s*/i, '');
            var ok = true;
            try { ok = window.matchMedia(cond).matches; } catch (e) { }
            if (ok) out += processCss(inner, keepFace, keepSelector);
          } else if (kw === 'font-face') {
            if (keepFace(inner)) out += prelude + '{' + inner + '}';
          } else if (kw === 'supports' || kw === 'container' ||
                     kw === 'layer' || kw === 'scope') {
            var body = processCss(inner, keepFace, keepSelector);
            if (body.trim()) out += prelude + '{' + body + '}';
          } else {
            out += prelude + '{' + inner + '}';        // @keyframes and friends
          }
          i = close + 1;
          continue;
        }
      }
      var brace = -1;
      for (var k = i; k < n; k++) {
        var cc = css.charAt(k);
        if (cc === '/' && css.charAt(k + 1) === '*') {
          var cx = css.indexOf('*/', k + 2);
          k = cx < 0 ? n : cx + 1;
          continue;
        }
        if (cc === '"' || cc === "'") { k = skipString(css, k); continue; }
        if (cc === '{') { brace = k; break; }
      }
      if (brace < 0) { out += css.slice(i); break; }
      var ruleEnd = matchBrace(css, brace);
      if (!keepSelector || keepSelector(css.slice(i, brace))) {
        out += css.slice(i, ruleEnd + 1);
      }
      i = ruleEnd + 1;
    }
    return out;
  }

  function familyKey(name) {
    return String(name || '').trim().replace(/^["']|["']$/g, '').toLowerCase();
  }

  /* Which @font-face families does this particular issue actually paint?
     Inlining all eighteen costs ~1.1MB of base64; a typical design uses two
     or three. Pseudo-elements carry type in these designs, so they are part
     of the walk. */
  function familiesUsed(root) {
    var seen = Object.create(null);
    var nodes = [root].concat([].slice.call(root.querySelectorAll('*')));
    var slots = [null, '::before', '::after'];
    nodes.forEach(function (node) {
      slots.forEach(function (slot) {
        var stack;
        try { stack = window.getComputedStyle(node, slot).fontFamily; } catch (e) { return; }
        if (!stack) return;
        stack.split(',').forEach(function (one) { seen[familyKey(one)] = 1; });
      });
    });
    return seen;
  }

  /* Assembling the sheet means scanning ~112KB, then a url() pass over a
     string that has grown to roughly a megabyte once the fonts are embedded.
     That is the bulk of an export, and it depends only on which font families
     the design uses - so cache it under exactly that key and a second stamp on
     the same family issue costs nothing. */
  var cssMemo = Object.create(null);

  function stampCss(root) {
    var used = familiesUsed(root);
    var key = Object.keys(used).sort().join('|');
    if (cssMemo[key]) return cssMemo[key];
    function keepFace(block) {
      var declared = /font-family\s*:\s*([^;}]+)/i.exec(block);
      return !!(declared && used[familyKey(declared[1])]);
    }
    var built = Promise.all([
      Promise.all(sheetHrefs(isPageSheet).map(sheetText)),
      Promise.all(stampSheetHrefs().map(sheetText))
    ]).then(function (groups) {
      // The reset goes first so the stamp sheets still override it.
      var reset = processCss(groups[0].join('\n'), function () { return false; },
                             isUniversalSelector);
      var body = processCss(groups[1].join('\n'), keepFace);
      // `:root` cannot match inside a foreignObject; the export root stands in.
      var css = (reset + '\n' + body).replace(/:root\b/g, '.sx-root');
      return inlineCssUrls(css);
    });
    cssMemo[key] = built;
    return built;
  }

  /* ---------- custom properties --------------------------------------- */

  var propNamesMemo = null;

  /* Design CSS reads a lot of inherited custom properties, some declared
     outside the stamp sheets entirely. Rather than guess where each one
     lives, scrape every name that any stamp rule mentions and copy its
     RESOLVED value off the live node - whatever the cascade decided is
     what the export inherits. */
  /* Names only - the values come off the live node, so whatever the cascade
     decided is what the export inherits, wherever the declaration lived. */
  function primeCustomPropNames() {
    return Promise.all(stampSheetHrefs().map(sheetText)).then(function (texts) {
      var names = Object.create(null);
      (texts.join('\n').match(/--[A-Za-z0-9_-]+/g) || []).forEach(function (n) {
        names[n] = 1;
      });
      propNamesMemo = Object.keys(names);
      return propNamesMemo;
    });
  }

  function inheritedProps(node) {
    var style = window.getComputedStyle(node);
    var names = propNamesMemo;
    if (!names || !names.length) return '';
    var out = [];
    names.forEach(function (name) {
      var value = style.getPropertyValue(name);
      if (value && value.trim()) out.push(name + ':' + value.trim());
    });
    return out.join(';');
  }

  /* ---------- SVG filter defs ----------------------------------------- */

  /* The perforation contour is an feMorphology dilate referenced by id from
     CSS. Left dangling, the hidden stencil renders unfiltered and the issue
     grows a solid rectangle behind it. Copy every zero-sized defs carrier in
     the document - #stampFilters from index.html and #stampFringeFilterDefs,
     which stamps.js builds at runtime. */
  function filterDefs() {
    var parts = [];
    [].slice.call(document.querySelectorAll('svg > defs')).forEach(function (defs) {
      var svg = defs.parentNode;
      if (svg.getAttribute('width') !== '0') return;
      parts.push(defs.outerHTML);
    });
    return parts.join('');
  }

  /* ---------- canvas flattening --------------------------------------- */

  /* cloneNode does not carry canvas pixels and a foreignObject cannot run
     script, so every ink plate has to be baked into the document. The plates
     are already painted at 4-5x (stamps.js sizes their backing store well
     above devicePixelRatio), which is what lets a 3x export stay crisp.

     The bitmap goes on as the canvas element's own BACKGROUND, and the
     <canvas> is deliberately left in place rather than swapped for an <img>.
     Three rules in the stamp CSS select the plate by tag name -
     `.tpl-dither .dth-panel canvas`, the same for terraplana, and
     `canvas.fxc` - and an <img> matches none of them. Swapping the tag drops
     `position:absolute;inset:0;width:100%;height:100%` on the halftone
     designs, so the plate lays out at its intrinsic 825x900 instead of its
     165x180 box and the export comes back with coarse, misplaced dots. Keeping
     the element means every selector still applies, including any upstream
     adds later. An empty canvas paints transparent, so the background shows
     through exactly where the pixels were. */
  function bakeCanvases(source, clone) {
    var from = source.querySelectorAll('canvas');
    var to = clone.querySelectorAll('canvas');
    for (var i = 0; i < to.length && i < from.length; i++) {
      var data;
      try { data = from[i].toDataURL('image/png'); }
      catch (e) { lastFailures.push('canvas ' + (from[i].dataset.fx || i)); continue; }
      to[i].style.backgroundImage = 'url("' + data + '")';
      to[i].style.backgroundSize = '100% 100%';
      to[i].style.backgroundRepeat = 'no-repeat';
      to[i].style.backgroundPosition = 'center';
      to[i].style.backgroundOrigin = 'border-box';
    }
  }

  /* Turn <img src> and SVG <image href> into data: URIs. */
  function inlineNodeAssets(root) {
    var jobs = [];
    [].slice.call(root.querySelectorAll('img')).forEach(function (img) {
      var src = img.getAttribute('src') || '';
      if (!src || /^data:/i.test(src)) return;
      jobs.push(asDataUri(new URL(src, location.href).href).then(function (uri) {
        if (uri) img.setAttribute('src', uri);
      }));
    });
    [].slice.call(root.querySelectorAll('image')).forEach(function (image) {
      var href = image.getAttribute('href') || image.getAttribute('xlink:href') || '';
      if (!href || /^data:/i.test(href) || href.charAt(0) === '#') return;
      jobs.push(asDataUri(new URL(href, location.href).href).then(function (uri) {
        if (!uri) return;
        image.setAttribute('href', uri);
        image.removeAttribute('xlink:href');
      }));
    });
    // Element style attributes carry the CSS-mask bird shapes as --src:url().
    [].slice.call(root.querySelectorAll('[style]')).concat([root]).forEach(function (el) {
      var css = el.getAttribute('style') || '';
      if (css.indexOf('url(') < 0) return;
      jobs.push(inlineCssUrls(css).then(function (next) { el.setAttribute('style', next); }));
    });
    return Promise.all(jobs);
  }

  /* ---------- the export --------------------------------------------- */

  /* One source of truth for the staging geometry. These rules must reach BOTH
     the offscreen host (so measure() sees the real box) and the export SVG (so
     the rasteriser lays it out the same way). Injecting them only into the page
     - which is what this used to do - left the export without them: inside the
     SVG `.stamp-fit` kept its inline box, `.stamp` centred against that instead
     of the export root, and the issue landed at (-13.5,-16.2) with its top-left
     clipped away, while every size still measured correct. */
  var NORMALIZE_CSS =
    '.sx-host{position:fixed!important;left:-99999px!important;top:0!important;' +
      'width:auto!important;height:auto!important;display:block!important;' +
      'contain:none!important;pointer-events:none!important;opacity:1!important;}' +
    '.sx-host>.stamp-fit,.sx-root>.stamp-fit{position:absolute!important;' +
      'left:0!important;top:0!important;right:auto!important;bottom:auto!important;' +
      'width:100%!important;height:100%!important;' +
      'transform:none!important;transition:none!important;filter:none!important;}' +
    '.sx-host .stamp,.sx-root .stamp,' +
    '.sx-host .stamp-fringe-outline,.sx-root .stamp-fringe-outline{' +
      'transition:none!important;animation:none!important;}';

  var hostStyle = null;

  function ensureHostStyle() {
    if (hostStyle) return;
    hostStyle = document.createElement('style');
    hostStyle.id = 'sx-host-style';
    hostStyle.textContent = NORMALIZE_CSS;
    document.head.appendChild(hostStyle);
  }

  function effectiveTheme() {
    var explicit = document.documentElement.getAttribute('data-theme');
    if (explicit === 'dark' || explicit === 'light') return explicit;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
      ? 'dark' : 'light';
  }

  /* Lay the issue out offscreen at its true size, un-rotated and unscaled,
     so the exported PNG is the stamp itself rather than the postcard's
     tilted, shrunk presentation of it. */
  function stageForExport(sourceFit) {
    ensureHostStyle();
    var host = document.createElement('div');
    // .atlas-grid is load-bearing: `.atlas-grid .stamp` is what positions the
    // figure and supplies --paper. Staging outside that context renders an
    // unpositioned stamp.
    host.className = 'atlas-grid sx-host';
    host.setAttribute('aria-hidden', 'true');

    var fit = sourceFit.cloneNode(true);
    fit.querySelectorAll('.stamp-peel-layer').forEach(function (el) { el.remove(); });
    ['--postcard-turn', '--postcard-scale', '--fit-scale'].forEach(function (name) {
      fit.style.removeProperty(name);
    });
    fit.style.setProperty('--fit-scale', '1');
    [].slice.call(fit.querySelectorAll('.stamp, .stamp-fringe-outline')).forEach(function (el) {
      el.style.setProperty('--scale', '1');
      el.style.setProperty('--tilt', '0deg');
    });

    // Size the host to the fit box so percentage geometry has something real
    // to resolve against before the stamp is measured.
    host.style.width = (parseFloat(sourceFit.style.width) || 188) + 'px';
    host.style.height = (parseFloat(sourceFit.style.height) || 236) + 'px';
    host.appendChild(fit);
    document.body.appendChild(host);

    bakeCanvases(sourceFit, fit);
    // The cut edge is copied from the live issue's computed geometry, so it
    // has to be recomputed now that scale is 1 and the box has changed.
    if (window.STAMPS && typeof window.STAMPS.syncFringe === 'function') {
      try { window.STAMPS.syncFringe(host); } catch (e) { }
    }
    return { host: host, fit: fit };
  }

  function measure(fit) {
    var stamp = fit.querySelector('.stamp');
    var box = (stamp || fit).getBoundingClientRect();
    return {
      w: Math.max(1, Math.ceil(box.width) + BLEED * 2),
      h: Math.max(1, Math.ceil(box.height) + BLEED * 2)
    };
  }

  function buildSvg(fit, size, css, defs, props, theme) {
    var body = new XMLSerializer().serializeToString(fit);
    // Definitions first, so every var() below resolves.
    css = assetPrelude(css + body + props) + '\n' + css;
    return '<svg xmlns="http://www.w3.org/2000/svg" ' +
             'width="' + (size.w * SCALE) + '" height="' + (size.h * SCALE) + '" ' +
             'viewBox="0 0 ' + size.w + ' ' + size.h + '">' +
             '<defs><style type="text/css"><![CDATA[\n' + css + '\n' + NORMALIZE_CSS + '\n]]></style></defs>' +
             defs +
             '<foreignObject x="0" y="0" width="' + size.w + '" height="' + size.h + '">' +
               '<div xmlns="' + XHTML + '" class="sx-root atlas-grid" data-theme="' + theme + '" ' +
                 'style="' + props + ';position:relative;width:' + size.w + 'px;height:' + size.h + 'px;">' +
                 body +
               '</div>' +
             '</foreignObject>' +
           '</svg>';
  }

  /* UTF-8 safe base64, chunked so a multi-megabyte document does not blow the
     argument limit on String.fromCharCode. */
  function toBase64(text) {
    var bytes = new TextEncoder().encode(text);
    var out = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(out);
  }

  function isBlank(cx, w, h) {
    var step = 4;
    try {
      var data = cx.getImageData(0, 0, w, h).data;
      for (var i = 3; i < data.length; i += 4 * step) {
        if (data[i] > 16) return false;
      }
    } catch (e) {
      return false;                       // cannot tell; do not block the export
    }
    return true;
  }

  function rasterise(svgText, size) {
    return new Promise(function (resolve, reject) {
      /* A data: URL, deliberately - NOT URL.createObjectURL.
         Chromium taints the canvas when an SVG carrying a <foreignObject> is
         loaded from a blob: URL, so toBlob then throws SecurityError and the
         export is impossible. The identical document served as a data: URL is
         treated as origin-clean and exports fine. Verified directly in the
         browser; the two differ on nothing else. Switching back to a blob URL
         to "avoid the base64 overhead" silently breaks the whole feature. */
      var img = new Image();
      img.decoding = 'sync';
      img.onload = function () {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = Math.round(size.w * SCALE);
          canvas.height = Math.round(size.h * SCALE);
          var cx = canvas.getContext('2d');
          cx.imageSmoothingEnabled = true;
          if ('imageSmoothingQuality' in cx) cx.imageSmoothingQuality = 'high';
          cx.drawImage(img, 0, 0, canvas.width, canvas.height);
          /* An oversized SVG is rasterised as nothing at all: the <img> fires
             onload, reports the correct intrinsic size, and paints a fully
             transparent frame. Nothing throws, so without this the user is
             handed a blank PNG and told it worked. Sample the result and fail
             loudly instead. A stride keeps it to a few milliseconds. */
          if (isBlank(cx, canvas.width, canvas.height)) {
            reject(new Error('the browser rasterised the issue as blank - the ' +
              'export document is likely too large at ' +
              Math.round(svgText.length / 1048576) + 'MB'));
            return;
          }
          // toBlob throws synchronously on a tainted canvas. Inside onload
          // that escapes the executor, so without this try the promise would
          // never settle and the button would spin for ever.
          canvas.toBlob(function (out) {
            out ? resolve(out) : reject(new Error('the browser returned no PNG data'));
          }, 'image/png');
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = function () {
        reject(new Error('the browser could not rasterise the issue'));
      };
      img.src = 'data:image/svg+xml;base64,' + toBase64(svgText);
    });
  }

  /* Public: hand back a PNG Blob for a live .stamp-fit node. */
  function toPngBlob(sourceFit) {
    lastFailures = [];
    var staged, theme, defs, size, props = '';
    /* The staging host is a real node in the document. If any of this
       synchronous prelude throws, the promise chain that would have removed it
       never starts, so it has to be torn down here - otherwise every failed
       click leaves another offscreen stamp behind. Rethrowing as a rejection
       also keeps the caller's single .catch sufficient. */
    try {
      staged = stageForExport(sourceFit);
      theme = effectiveTheme();
      defs = filterDefs();
      size = measure(staged.fit);
    } catch (err) {
      if (staged && staged.host) staged.host.remove();
      return Promise.reject(err);
    }

    return Promise.resolve()
      .then(function () { return document.fonts && document.fonts.ready; })
      // The names have to be known before the live node is read, and they come
      // from the same stylesheet text the export embeds.
      .then(primeCustomPropNames)
      .then(function () {
        props = inheritedProps(sourceFit);
        return Promise.all([stampCss(staged.fit), inlineNodeAssets(staged.fit)]);
      })
      .then(function (parts) {
        return rasterise(buildSvg(staged.fit, size, parts[0], defs, props, theme), size);
      })
      .then(function (blob) {
        return { blob: blob, width: size.w * SCALE, height: size.h * SCALE, failures: lastFailures.slice() };
      })
      .finally(function () { staged.host.remove(); });
  }

  function slug(text) {
    return String(text || 'stamp').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'stamp';
  }

  function fileNameFor(fit) {
    var stamp = fit.querySelector('.stamp');
    var common = fit.dataset.common || (stamp && stamp.dataset.common) || 'stamp';
    var design = (stamp && stamp.dataset.style) || '';
    return slug(common) + (design ? '-' + slug(design) : '') + '.png';
  }

  function save(blob, name) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /* ---------- the control -------------------------------------------- */

  var ICON =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M8 2.6v7.2"/><path d="M4.9 7l3.1 3 3.1-3"/><path d="M3 12.6h10"/>' +
    '</svg>';

  /* The control ships its own CSS so the feature stays one file. It is a
     handful of rules and it must not be in styles.css, which upstream edits. */
  var btnStyle = null;
  function ensureButtonStyle() {
    if (btnStyle) return;
    btnStyle = document.createElement('style');
    btnStyle.id = 'sx-button-style';
    btnStyle.textContent = [
      '.postcard-stamp-slot .sx-dl{position:absolute;right:5px;bottom:5px;z-index:6;',
        'width:26px;height:26px;padding:0;display:grid;place-items:center;',
        'border:0;border-radius:50%;cursor:pointer;',
        'color:#f6f2e8;background:rgba(24,20,15,.62);',
        '-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);',
        'box-shadow:0 1px 4px rgba(0,0,0,.32);',
        'opacity:.82;transition:opacity 160ms ease,transform 160ms ease,background 160ms ease;}',
      '.postcard-stamp-slot .sx-dl svg{width:14px;height:14px;display:block;}',
      '.postcard-stamp-slot .sx-dl:hover{opacity:1;background:rgba(24,20,15,.8);}',
      '.postcard-stamp-slot .sx-dl:active{transform:scale(.92);}',
      '.postcard-stamp-slot .sx-dl:focus-visible{opacity:1;outline:2px solid currentColor;outline-offset:2px;}',
      // Pointer-capable devices get a quiet control that surfaces on hover;
      // touch has no hover state, so there it simply stays visible.
      '@media (hover:hover) and (pointer:fine){',
        '.postcard-stamp-slot .sx-dl{opacity:0;pointer-events:none;}',
        '.postcard-stamp-slot:hover .sx-dl,',
        '.postcard-sheet:focus-within .postcard-stamp-slot .sx-dl{opacity:.82;pointer-events:auto;}',
        '.postcard-stamp-slot:hover .sx-dl:hover{opacity:1;}}',
      '.postcard-stamp-slot .sx-dl[data-state="working"]{opacity:1;pointer-events:none;}',
      '.postcard-stamp-slot .sx-dl[data-state="working"] svg{animation:sx-pulse 900ms ease-in-out infinite;}',
      '.postcard-stamp-slot .sx-dl[data-state="done"]{opacity:1;background:rgba(31,79,82,.86);}',
      '.postcard-stamp-slot .sx-dl[data-state="partial"]{opacity:1;background:rgba(169,78,45,.86);}',
      '.postcard-stamp-slot .sx-dl[data-state="failed"]{opacity:1;background:rgba(169,45,45,.9);}',
      '@keyframes sx-pulse{0%,100%{opacity:.45}50%{opacity:1}}',
      '@media (prefers-reduced-motion:reduce){',
        '.postcard-stamp-slot .sx-dl,.postcard-stamp-slot .sx-dl svg{transition:none;animation:none;}}'
    ].join('');
    document.head.appendChild(btnStyle);
  }

  function makeButton() {
    ensureButtonStyle();
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sx-dl';
    btn.title = 'Download this stamp as a PNG';
    btn.setAttribute('aria-label', 'Download this stamp as a PNG');
    btn.innerHTML = ICON;
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      var slot = btn.parentNode;
      var fit = slot && slot.querySelector('.stamp-fit');
      if (!fit || btn.dataset.busy) return;
      btn.dataset.busy = '1';
      btn.dataset.state = 'working';
      toPngBlob(fit).then(function (result) {
        save(result.blob, fileNameFor(fit));
        if (result.failures.length) {
          btn.dataset.state = 'partial';
          btn.title = 'Downloaded, but ' + result.failures.length +
            ' asset(s) could not be embedded - see the console';
          console.warn('[stamp-export] incomplete export:', result.failures);
        } else {
          btn.dataset.state = 'done';
        }
      }).catch(function (err) {
        btn.dataset.state = 'failed';
        btn.title = 'Export failed: ' + (err && err.message || err);
        console.error('[stamp-export]', err);
      }).finally(function () {
        delete btn.dataset.busy;
        setTimeout(function () {
          if (btn.dataset.state !== 'failed' && btn.dataset.state !== 'partial') {
            btn.removeAttribute('data-state');
          }
        }, 1400);
      });
    });
    return btn;
  }

  /* apt.js owns the slot's contents and clears it with innerHTML='' on every
     open and close, so the button cannot simply be appended once. Watch the
     slot and re-attach whenever an issue lands in it. Re-attaching mutates
     the slot and re-enters this callback, but the guard makes the second
     pass a no-op, so it settles rather than looping. */
  function watchSlot(slot) {
    function sync() {
      var hasStamp = !!slot.querySelector('.stamp-fit');
      var btn = slot.querySelector(':scope > .sx-dl');
      if (hasStamp && !btn) slot.appendChild(makeButton());
      else if (!hasStamp && btn) btn.remove();
    }
    new MutationObserver(sync).observe(slot, { childList: true });
    sync();
  }

  function install() {
    var slot = document.querySelector('#postcard-modal .postcard-stamp-slot');
    if (!slot) return;
    watchSlot(slot);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }

  /* toSvgText is the debugging affordance for this module: it returns the exact
     document handed to the rasteriser, so it can be loaded into an iframe and
     measured against the live node. Geometry faults - a container-query unit
     resolving against the wrong box, say - are a few percent and invisible in a
     thumbnail; they are obvious the moment you can measure the real DOM. */
  function toSvgText(sourceFit) {
    lastFailures = [];
    var staged, theme, defs, size, props = '';
    try {
      staged = stageForExport(sourceFit);
      theme = effectiveTheme();
      defs = filterDefs();
      size = measure(staged.fit);
    } catch (err) {
      if (staged && staged.host) staged.host.remove();
      return Promise.reject(err);
    }
    return Promise.resolve()
      .then(function () { return document.fonts && document.fonts.ready; })
      .then(primeCustomPropNames)
      .then(function () {
        props = inheritedProps(sourceFit);
        return Promise.all([stampCss(staged.fit), inlineNodeAssets(staged.fit)]);
      })
      .then(function (parts) {
        return { svg: buildSvg(staged.fit, size, parts[0], defs, props, theme), size: size };
      })
      .finally(function () { staged.host.remove(); });
  }

  window.STAMP_EXPORT = {
    toPngBlob: toPngBlob, toSvgText: toSvgText,
    fileNameFor: fileNameFor, save: save, scale: SCALE
  };
})();
