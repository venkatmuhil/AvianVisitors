#!/usr/bin/env python3
"""Stage B of the genus-groups pipeline: validate group-plan.json and emit
avian/frontend/stamp-batch-local.js deterministically (same inputs -> byte
identical output).

The emitted file loads AFTER the upstream stamp batches (last script tag in
index.html), so its assignments win: that is how genera are re-homed out of
upstream's flight-composed 'Gulls' / 'Doves & Pigeons' groups without editing
upstream's literals.

Validation rules (mirrored by verify-stamps CHECKs 5-9 at the frontend level):
  - designs must be production stamps; never field/sparrow proofs
  - kieler ({{SRC_ALT}} -> forced flight plate) is off-limits for new groups
  - dove-flight only renders flight via the 'Doves & Pigeons' markup() hardcode,
    so it is not assigned to new groups either
  - raptor prints a hardcoded ACCIPITRIDAE, so only latin=Accipitridae may use it
  - names on {{FAMILY}}-printing designs have length caps (curved textPath /
    narrow boxes on mexico/terraplana/zurichpink)
  - 'Doves & Pigeons' extensions require every species of the genus to have a
    -2 flight plate in dims.json
  - every genus with art ends up in exactly one effective group
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FRONTEND = os.path.join(HERE, "..", "..", "frontend")
PLAN_PATH = os.path.join(HERE, "group-plan.json")
FAMILIES_PATH = os.path.join(HERE, "genus-families.json")
DIMS_PATH = os.path.join(FRONTEND, "dims.json")
STAMPS_PATH = os.path.join(FRONTEND, "stamps.js")
OUT_PATH = os.path.join(FRONTEND, "stamp-batch-local.js")

# The 24 production designs of ORDERED_STYLES plus raptor. field and the
# sparrow proofs are deliberately absent (styleless / unfinished).
ALLOWED_DESIGNS = {
    "flock", "dither", "geo", "mono", "bundespost", "zurichpink", "mexico",
    "kieler", "linescreen", "terraplana", "opart", "nzplate", "editorial",
    "minimal", "dove-flight", "finch-editorial", "flyRose", "mimicLine",
    "ribbonbird", "sparrowGuide", "squaretone", "thrushFlora", "triennale",
    "waxBotanical", "raptor",
}
BANNED_DESIGNS = {"field", "sparrowFine", "sparrowRosette", "sparrowDirectional"}
# Flight-composed: kieler's html uses {{SRC_ALT}} (always resolved to pose 2);
# dove-flight relies on markup()'s 'Doves & Pigeons' hardcode, so on any other
# group it would frame a perched cutout as flight. Neither may back a new group.
FLIGHT_DESIGNS = {"kieler", "dove-flight"}
# {{FAMILY}} (the group display name) prints on these; the first three have
# tight geometry (33px textPath arc / 24%-wide box).
FAMILY_PRINTING_TIGHT = {"mexico", "terraplana", "zurichpink"}
FAMILY_PRINTING_WIDE = {"dither", "editorial", "minimal"}


def parse_upstream_genus_group():
    src = open(STAMPS_PATH).read()
    m = re.search(r"var GENUS_GROUP = \{(.*?)\n  \};", src, re.S)
    if not m:
        sys.exit("could not locate GENUS_GROUP literal in stamps.js")
    return dict(re.findall(r"(\w+):\s*'([^']+)'", m.group(1)))


def fail(errors):
    for e in errors:
        print("ERROR: " + e, file=sys.stderr)
    sys.exit(1)


def main():
    plan = json.load(open(PLAN_PATH))["groups"]
    families = json.load(open(FAMILIES_PATH))
    dims = json.load(open(DIMS_PATH))
    upstream = parse_upstream_genus_group()
    upstream_names = set(upstream.values())

    errors = []
    genus_to_group = {}   # from the plan only
    new_groups = {}       # name -> {latin, design}

    for entry in plan:
        name = entry.get("name", "")
        genera = entry.get("genera", [])
        if not name or not genera:
            errors.append("entry missing name/genera: %r" % entry)
            continue
        if entry.get("extend"):
            if name not in upstream_names:
                errors.append("extend target %r is not an upstream group" % name)
        else:
            latin = entry.get("latin", "")
            design = entry.get("design", "")
            if name in upstream_names:
                errors.append("new group %r collides with an upstream group name" % name)
            if not latin:
                errors.append("group %r has empty latin" % name)
            if design in BANNED_DESIGNS:
                errors.append("group %r uses banned design %r" % (name, design))
            elif design not in ALLOWED_DESIGNS:
                errors.append("group %r uses unknown design %r" % (name, design))
            if design in FLIGHT_DESIGNS:
                errors.append(
                    "group %r uses flight-composed design %r (needs -2 art "
                    "for every member; not allowed for new groups)" % (name, design)
                )
            if design == "raptor" and latin != "Accipitridae":
                errors.append("group %r uses raptor but latin is %r" % (name, latin))
            if design in FAMILY_PRINTING_TIGHT and len(name) > 12:
                errors.append("group name %r too long (>12) for design %r" % (name, design))
            if design in FAMILY_PRINTING_WIDE and len(name) > 20:
                errors.append("group name %r too long (>20) for design %r" % (name, design))
            if name in new_groups:
                errors.append("group %r defined twice" % name)
            new_groups[name] = {"latin": latin, "design": design}
        for g in genera:
            if g in genus_to_group:
                errors.append("genus %r listed in both %r and %r" % (g, genus_to_group[g], name))
            genus_to_group[g] = name
            if g not in families:
                errors.append("genus %r (group %r) has no art in dims.json" % (g, name))

    # 'Doves & Pigeons' extensions must be fully flight-covered: markup()
    # forces pose 2 for that family name.
    for g, name in genus_to_group.items():
        if name == "Doves & Pigeons" and g in families:
            fam = families[g]
            missing = sorted(set(fam["species"]) - set(fam["flight"]))
            if missing:
                errors.append(
                    "genus %r joins 'Doves & Pigeons' but lacks flight plates: %s"
                    % (g, ", ".join(missing))
                )

    # Every genus with art must resolve to a group (upstream or plan).
    unmapped = sorted(g for g in families if g not in genus_to_group and g not in upstream)
    if unmapped:
        errors.append("genera with art but no group: %s" % ", ".join(unmapped))

    # dims sanity: every base slug's genus is in families (fetch step guarantees).
    for slug in dims:
        if slug.endswith("-2"):
            continue
        genus = slug.split("-")[0].capitalize()
        if genus not in families:
            errors.append("dims slug %r has genus missing from genus-families.json" % slug)

    if errors:
        fail(errors)

    def js_str(s):
        return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"

    lines = []
    lines.append("/* Generated by avian/tools/genus-groups/build_batch.py - DO NOT EDIT BY HAND.")
    lines.append(" * Edit group-plan.json and re-run the generator instead.")
    lines.append(" *")
    lines.append(" * Fork-owned stamp batch: widens the genus->family-issue mapping to every")
    lines.append(" * genus with art. Loads LAST (after stamp-batch-c.js), so assignments here")
    lines.append(" * win over upstream's GENUS_GROUP entries - that is how genera are re-homed")
    lines.append(" * out of the flight-composed 'Gulls' / 'Doves & Pigeons' groups.")
    lines.append(" * Requires stamps.js local carry #5 (GENUS_GROUP on window.STAMPS); if that")
    lines.append(" * carry is lost this file is inert and verify-stamps CHECK 5 fails. */")
    lines.append("(function () {")
    lines.append("  'use strict';")
    lines.append("  var S = window.STAMPS;")
    lines.append("  if (!S || !S.GENUS_GROUP || !S.GROUP_LATIN || !S.GROUP_STYLE) { return; }")
    lines.append("  var G = {")
    for g in sorted(genus_to_group):
        lines.append("    %s: %s," % (g, js_str(genus_to_group[g])))
    lines.append("  };")
    lines.append("  var L = {")
    for name in sorted(new_groups):
        lines.append("    %s: %s," % (js_str(name), js_str(new_groups[name]["latin"])))
    lines.append("  };")
    lines.append("  var D = {")
    for name in sorted(new_groups):
        lines.append("    %s: %s," % (js_str(name), js_str(new_groups[name]["design"])))
    lines.append("  };")
    lines.append("  var k;")
    lines.append("  for (k in G) { S.GENUS_GROUP[k] = G[k]; }")
    lines.append("  for (k in L) { S.GROUP_LATIN[k] = L[k]; }")
    lines.append("  for (k in D) { S.GROUP_STYLE[k] = D[k]; }")
    lines.append("})();")

    with open(OUT_PATH, "w") as f:
        f.write("\n".join(lines) + "\n")

    n_species = sum(len(families[g]["species"]) for g in genus_to_group)
    print(
        "wrote %s: %d genus assignments (%d species), %d new groups"
        % (os.path.relpath(OUT_PATH, HERE), len(genus_to_group), n_species, len(new_groups)),
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
