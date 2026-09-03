# Offline page for `birds.7ml.in`

When the Pi drops off the network, `cloudflared` disconnects and Cloudflare's
edge answers with its own **error 1033** interstitial (HTTP 530). This replaces
that with a page in the collage's own voice.

Open `preview.html` in a browser to see it.

## Why a Worker

Cloudflare's dashboard *Custom Pages* — the obvious place to swap an error page —
only covers 5xx/1xxx errors on **Enterprise** zones. A free or Pro zone cannot
replace the 1033 page from settings at all. A Worker bound to the route is the
only mechanism available: it intercepts the request, tries the origin itself,
and substitutes its own response when the origin does not answer.

## Files

| file | |
|---|---|
| `offline.html` | **the source.** Edit this. |
| `bench-cliff.webp` | the illustration — offline-only art, lives here not in `frontend/` |
| `build.js` | inlines the assets, emits the two files below |
| `worker.js` | *generated* — the deployable worker |
| `preview.html` | *generated* — the same page, openable from disk |
| `test.mjs` | exercises the worker's decision table against a stubbed origin |
| `wrangler.toml` | name, route, compatibility date |

```bash
node build.js && node test.mjs
```

## Two constraints that shape everything here

**1. The page cannot fetch anything from the Pi.** That is the failure case. No
`styles.css`, no `Caveat.woff2`, no `nest.webp` over the wire. `build.js` inlines
`bench-cliff.webp`, `stats-press.png`, `favicon.png` and `7ml-mark.svg` as
`data:` URIs. All but the illustration are read from the live frontend, so a
re-baked press tile or a changed 7ML mark is picked up on the next build; the
illustration is offline-only art and sits here.

The 7ML mark is bottom-**centre** here rather than the collage's bottom-left,
because this page is a single centred column and a corner mark would read as
stray. Same 28px/22px sizing, same `0.8` opacity, same hover lift. Its link out
to `7ml.in` is the one non-`data:` href on the page — navigation the visitor
chooses, not a subresource the page loads, which is the distinction `test.mjs`
now draws.

The illustration is deliberately **not** the collage's empty nest. The nest
means *no detections heard in this window* — a different fact, and a lie
during an outage, since the station may well be hearing birds. An empty bench
says unreachable. It also sits **above** the press screen (`z-index: 6`): on
the real site that screen is on `#v1`, the stats view, over type and charts,
and the collage's own cutouts get no screen at all. Under it the watercolour
washes out in light and speckles badly in dark. `test.mjs` asserts no non-`data:` `src`/`href`
survives into the response. The design tokens and type scale are copied out of
`styles.css` into the page's own `<style>`; they are a **carry**, and if the
site's palette changes they must be updated here by hand.

**2. The route is root-only, and that is deliberate.** Worker routes run *before*
the Cloudflare cache. A `birds.7ml.in/*` route would sit in front of
`masks.json`, `dims.json` and all eight `birdnet-api.php` calls on every request:
~15x the invocations per page view against the free plan's 100k/day, and a new
moving part in the path of the `Cache collage JSON tables` rule that CLAUDE.md
warns about. The root document is the only thing a visitor ever sees the 1033
page *instead of*, so it is the only thing worth intercepting.

## What the worker does

Passes the origin's response straight through — including 4xx, which is a live
station *saying no* rather than a dead one. Falls back to the offline page on:

* a thrown subrequest (DNS or connect failure),
* no answer within 10s (Cloudflare would otherwise wait ~100s), and
* status `502 503 504 520–527 530`.

The fallback is served as **503** with `Retry-After: 30`, `Cache-Control:
no-store` and `X-Robots-Tag: noindex`, so an outage snapshot can never be indexed
or cached in place of the real collage.

## How a visitor gets back in

The page polls `/` and reloads as soon as the station answers. The signal is the
**absence** of the `x-avian-offline: 1` header the worker stamps on its own
responses — a body check would be fooled by any cached copy of the page itself.

Polling backs off `30s → 30s → 60s → 120s → 300s` and pauses while the tab is
hidden, so a tab left open through a long outage does not spend an invocation
every 30 seconds. Returning to the tab, or the *check now* button, resets it.

## Deploying

Needs Cloudflare account access, which nothing in this repo carries.

**With wrangler** (from this directory):

```bash
npx wrangler login     # opens a browser; one time
npx wrangler deploy
```

**Or by hand,** if you would rather not authorise a CLI: Cloudflare dashboard →
*Workers & Pages* → *Create* → *Create Worker* → name it `birds-offline` → paste
the whole of `worker.js` → *Deploy*. Then *Settings* → *Domains & Routes* → *Add
route* → route `birds.7ml.in/`, zone `7ml.in`.

Either way the worker is ~146 KB, comfortably inside the free plan's 1 MB limit.

## Verifying it

While the Pi is **up**, the route must be invisible:

```bash
curl -sI https://birds.7ml.in/ | grep -i -E 'HTTP/|x-avian-offline'
# expect: HTTP/2 200, and no x-avian-offline header
```

And confirm the worker did not disturb the caching posture CLAUDE.md documents —
the API must still be `DYNAMIC`, the JSON tables still `HIT`:

```bash
curl -sI "https://birds.7ml.in/avian/api/birdnet-api.php?action=stats" | grep -i cf-cache-status
curl -sI https://birds.7ml.in/masks.json | grep -i cf-cache-status
```

To see the offline page for real, stop the tunnel on the Pi and load the site:

```bash
sudo systemctl stop cloudflared     # then load https://birds.7ml.in/
sudo systemctl start cloudflared    # the open tab should reload itself
```

## Updating the page

Edit `offline.html`, then `node build.js && node test.mjs`, then redeploy. The
generated files are committed so the deployable artefact is reviewable in the
diff, but they are outputs — never edit `worker.js` or `preview.html` directly.
