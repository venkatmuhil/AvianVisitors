# genus-groups

Generates `avian/frontend/stamp-batch-local.js` — the fork's whole-catalogue
genus → family-issue map for the Atlas stamp system.

## Why this exists

`stamps.js` picks a stamp design in three tiers: a per-species pin, then a
**family issue** (`GENUS_GROUP` → `GROUP_STYLE`), then a stable hash over
`ORDERED_STYLES`. Upstream's `GENUS_GROUP` is entirely North American, so at a
station outside that range most species landed on tier 3 — an *arbitrary*
design rather than a chosen one. Before this tool, 554 of 888 species with art
(62%) were hashed.

Rather than edit upstream's literal (a large merge-conflict surface, and its
block anchors matter for merges), the map is widened from a fork-owned batch
file that loads **last**. Later-wins assignment is also what lets a genus be
re-homed out of upstream's flight-composed `Gulls` / `Doves & Pigeons` groups
without touching upstream's code.

Requires the `GENUS_GROUP` export in `stamps.js` (local carry #5). Without it
the generated file is inert — `verify-stamps` CHECK 5 catches that.

## Files

| file | role |
|---|---|
| `fetch_families.py` | **Stage A.** Reads `dims.json`, resolves every genus to a taxonomic family. |
| `genus-families.json` | Generated. Per genus: `familySci`, `familyCom`, `order`, `species[]`, `flight[]`. |
| `genus-families.curated.json` | Hand-written overlay, applied last. For genera the API can't resolve (recent splits, synonyms) or resolves wrongly. |
| `group-plan.json` | **The file you edit.** Curated genus → group → design decisions. |
| `build_batch.py` | **Stage B.** Validates the plan and emits the JS. Idempotent. |

## Regenerating

```bash
python3 avian/tools/genus-groups/fetch_families.py   # only when the art set changes
python3 avian/tools/genus-groups/build_batch.py
node avian/tools/verify-stamps/verify-stamps.js
```

Stage A uses the eBird taxonomy API when `EBIRD_API_KEY` is set (one bulk
request), and otherwise falls back to keyless GBIF species-match (one request
per genus, ~1 min for 437). Either way the curated overlay is applied on top.
It exits non-zero listing any genus it could not resolve; add those to
`genus-families.curated.json` and re-run.

Stage A is only needed when the **art set** changes. Editing group assignments
needs Stage B alone.

## Adding a species

`dims.json` is the source of truth for what has art. If a new cutout's genus is
already in `group-plan.json`, nothing here changes. If it is new, `build_batch.py`
refuses to emit ("genera with art but no group") and `verify-stamps` CHECK 9
fails. Add the genus to an existing group's `genera` list, or define a new group.

## group-plan.json

Two entry shapes:

```jsonc
// add genera to an UPSTREAM group; its latin + design stay as upstream sets them
{ "extend": true, "name": "Hawks", "genera": ["Aquila", "Milvus"] }

// define a NEW group
{ "name": "Bulbuls", "latin": "Pycnonotidae", "design": "terraplana",
  "genera": ["Pycnonotus", "Hypsipetes"] }
```

`latin` is the true family for a single-family group, or the shared **order**
for a deliberately coarse bucket (`Swifts` → `Apodiformes`). Never a family the
members don't belong to, and never empty — it prints on ~23 designs as
`{{ORDER}}` and backs the species modal's Family field.

### Rules `build_batch.py` enforces

- Never `field` / `sparrowFine` / `sparrowRosette` / `sparrowDirectional`
  (styleless or unfinished proofs).
- `raptor` only where `latin` is `Accipitridae` — it prints ACCIPITRIDAE in the
  artwork, which is a false claim on anything else and looks perfectly fine.
- `kieler` and `dove-flight` are off-limits for new groups. `kieler`'s html uses
  `{{SRC_ALT}}`, which `markup()` always resolves to the pose-2 flight plate;
  `dove-flight` draws flight only via `markup()`'s `'Doves & Pigeons'` hardcode,
  so anywhere else it frames a perched cutout as flight. A species without a
  `-2` asset in either case renders **blank paper with a clean console**.
- Genera may join `Doves & Pigeons` only with 100% `-2` coverage.
- Group names print as `{{FAMILY}}` on `dither`, `editorial`, `minimal`,
  `mexico`, `terraplana`, `zurichpink`. The last three have tight geometry (a
  33px curved textPath, a 24%-wide box), so names there are capped at 12
  characters; the others at 20.
- Every genus appears in exactly one group; every genus with art has a group.
- New group names must not collide with upstream's 17.

`ORDERED_STYLES` — the tier-3 hash pool — is deliberately **not** touched. Its
length is the hash modulus, so changing it reshuffles every hashed species.

### Things the generator can't check

Group names are user-visible: they head the Atlas family-sort sections, sort
alphabetically, and key `data-family` CSS. Two alphabetically **adjacent**
groups sharing a design weakens the "each family reads as its own issue" effect
— worth eyeballing after a change, since which groups appear depends on what
the station has actually detected.
