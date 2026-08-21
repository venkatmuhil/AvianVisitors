#!/usr/bin/env python3
"""Stage A of the genus-groups pipeline: derive genus -> taxonomic family.

Reads avian/frontend/dims.json (the art catalogue; keys are species slugs like
"pycnonotus-cafer", with "-2" suffixes marking flight plates), reconstructs the
binomial for every base slug, and resolves each genus to its family/order via:

  1. eBird taxonomy API   (needs EBIRD_API_KEY; one request for everything)
  2. GBIF species-match   (keyless; one request per genus, class=Aves scoped)
  3. genus-families.curated.json  (committed overlay; ALWAYS applied last, so
     it both patches API results for synonyms and serves as the full offline
     fallback)

Output: genus-families.json next to this script — sorted keys, 2-space indent,
so re-runs are idempotent and diffs are per-genus.

Usage:
  python3 fetch_families.py [--source auto|ebird|gbif|curated]

This is a one-shot generation tool, not a runtime dependency. Stage B
(build_batch.py) consumes the output together with the hand-curated
group-plan.json.
"""

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DIMS_PATH = os.path.join(HERE, "..", "..", "frontend", "dims.json")
CURATED_PATH = os.path.join(HERE, "genus-families.curated.json")
OUT_PATH = os.path.join(HERE, "genus-families.json")

EBIRD_URL = "https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json"
GBIF_URL = "https://api.gbif.org/v1/species/match"


def load_dims():
    with open(DIMS_PATH) as f:
        dims = json.load(f)
    base = sorted(k for k in dims if not k.endswith("-2"))
    flights = {k[:-2] for k in dims if k.endswith("-2")}
    genera = {}
    for slug in base:
        parts = slug.split("-")
        if len(parts) != 2:
            sys.exit("unexpected slug shape (not genus-epithet): %r" % slug)
        genus = parts[0].capitalize()
        g = genera.setdefault(genus, {"species": [], "flight": []})
        g["species"].append(slug)
        if slug in flights:
            g["flight"].append(slug)
    return genera


def binomial(slug):
    genus, epithet = slug.split("-")
    return genus.capitalize() + " " + epithet


def http_json(url, headers=None, timeout=60):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def resolve_ebird(genera, key):
    """One bulk call; index familySciName/familyComName/order by genus."""
    print("fetching eBird taxonomy (bulk)...", file=sys.stderr)
    taxa = http_json(EBIRD_URL, headers={"X-eBirdApiToken": key}, timeout=300)
    by_sci = {t.get("sciName"): t for t in taxa}
    by_genus = {}
    for t in taxa:
        sci = t.get("sciName") or ""
        genus = sci.split(" ")[0]
        # species-rank entries only; first hit per genus wins (taxonomy is
        # consistent within a genus)
        if genus and genus not in by_genus and t.get("familySciName"):
            by_genus[genus] = t
    out = {}
    for genus, info in genera.items():
        t = None
        for slug in info["species"]:
            t = by_sci.get(binomial(slug))
            if t and t.get("familySciName"):
                break
        if not (t and t.get("familySciName")):
            t = by_genus.get(genus)
        if t and t.get("familySciName"):
            out[genus] = {
                "familySci": t["familySciName"],
                "familyCom": t.get("familyComName", ""),
                "order": t.get("order", ""),
            }
    return out


def resolve_gbif(genera):
    """Per-genus match using one representative binomial, scoped to Aves."""
    out = {}
    items = sorted(genera.items())
    for i, (genus, info) in enumerate(items):
        name = binomial(info["species"][0])
        qs = urllib.parse.urlencode(
            {"name": name, "class": "Aves", "strict": "false"}
        )
        try:
            m = http_json(GBIF_URL + "?" + qs, timeout=30)
        except Exception as e:  # noqa: BLE001 - report and move on
            print("GBIF error for %s: %s" % (name, e), file=sys.stderr)
            continue
        if m.get("class") == "Aves" and m.get("family"):
            out[genus] = {
                "familySci": m["family"],
                "familyCom": "",
                "order": m.get("order", ""),
            }
        else:
            print(
                "GBIF no-family for %s (matchType=%s)"
                % (name, m.get("matchType")),
                file=sys.stderr,
            )
        if i % 25 == 0:
            print("  gbif %d/%d" % (i, len(items)), file=sys.stderr)
        time.sleep(0.05)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--source", choices=["auto", "ebird", "gbif", "curated"], default="auto"
    )
    args = ap.parse_args()

    genera = load_dims()
    n_species = sum(len(g["species"]) for g in genera.values())
    n_flight = sum(len(g["flight"]) for g in genera.values())
    print(
        "dims.json: %d genera, %d species, %d flight plates"
        % (len(genera), n_species, n_flight),
        file=sys.stderr,
    )

    key = os.environ.get("EBIRD_API_KEY", "").strip()
    source = args.source
    if source == "auto":
        source = "ebird" if key else "gbif"
    if source == "ebird" and not key:
        sys.exit("--source ebird needs EBIRD_API_KEY")

    resolved = {}
    if source == "ebird":
        resolved = resolve_ebird(genera, key)
    elif source == "gbif":
        resolved = resolve_gbif(genera)
    # source == "curated": overlay below does all the work

    curated = {}
    if os.path.exists(CURATED_PATH):
        with open(CURATED_PATH) as f:
            curated = json.load(f)
        curated.pop("_README", None)

    out = {}
    missing = []
    for genus in sorted(genera):
        rec = dict(resolved.get(genus) or {})
        rec.update(curated.get(genus) or {})  # curated overlay wins
        if not rec.get("familySci"):
            missing.append(genus)
            continue
        rec.setdefault("familyCom", "")
        rec.setdefault("order", "")
        rec["species"] = genera[genus]["species"]
        rec["flight"] = genera[genus]["flight"]
        out[genus] = {
            k: rec[k]
            for k in ("familySci", "familyCom", "order", "species", "flight")
        }

    if missing:
        print(
            "UNRESOLVED (%d) — add to %s: %s"
            % (len(missing), os.path.basename(CURATED_PATH), ", ".join(missing)),
            file=sys.stderr,
        )
        sys.exit(1)

    with open(OUT_PATH, "w") as f:
        json.dump(out, f, indent=2, sort_keys=True)
        f.write("\n")
    print(
        "wrote %s: %d genera / %d species"
        % (os.path.basename(OUT_PATH), len(out), n_species),
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
