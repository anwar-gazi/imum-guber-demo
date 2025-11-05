# Brand Assignment Demo — README

A compact, offline prototype for assigning **canonical brands** to pharmacy items from unstructured product titles. It uses graph grouping, normalization + rule gates, n-gram matching, deterministic tie-breaks, and a dry-run reporter.

---

## Contents

* [What problem this solves](#what-problem-this-solves)
* [Data inputs](#data-inputs)
* [How it works (pipeline)](#how-it-works-pipeline)
* [Algorithms & data structures](#algorithms--data-structures)
* [Matching rules](#matching-rules)
* [Efficiency: before vs after](#efficiency-before-vs-after)
* [CLI & tests](#cli--tests)
* [Design choices & differences from the starter code](#design-choices--differences-from-the-starter-code)

---

## What problem this solves

* Deduplicate >15k brands and **always assign a single canonical brand** per synonym group.
* Avoid false positives in titles (e.g., “ULTRA CLEAN” shouldn’t make everything **ultra**).
* Be **deterministic**: same title → same brand, with clear precedence when multiple brands match.

---

## Data inputs

* `brandConnections.json` — edges that imply brand **synonyms** (undirected). Example row:

  ```
  { "manufacturer_p1": "heel", "manufacturers_p2": "gripp-heel;heel" }
  ```
* `brandsMapping.json` — **required** enrichment map `{ aliasKey: [aliases...] }`. Always merged into the connection-based groups.
* `pharmacyItems.json` — sample product titles to run locally.

---

## How it works (pipeline)

1. **Level 1 — Canonical groups**

   * Build an **undirected graph** from `brandConnections.json`.
   * Compute **connected components**; each is a synonym group.
   * Choose **one canonical** per group (lexicographic by normalized name).
   * Create `aliasToCanonical` (normalized alias → canonical) for O(1) lookups.
   * Enrich groups by merging `brandsMapping.json` (required).

2. **Level 2 — Rule gate**

   * Normalize titles (diacritic fold, lowercase), tokenize, trim edge punctuation.
   * Placement/case rules:

     * **Front-only**: `rich, rff, flex, ultra, gum, beauty, orto, free, 112, kin, happy` must be at index **0**
     * **1st or 2nd**: `heel, contour, nero, rsv`
     * **HAPPY** must be **UPPERCASE** at front
     * Ignore **stopwords**: `BIO`, `NEB`.

3. **Level 3 — N-gram + tie-break**

   * Slide **1..4-gram** windows over tokens; for each span, try `" "`, `"-"`, `"_"` variants.
   * Lookup in `aliasToCanonical`; guard with whole-word regex + rule gate.
   * Keep best metrics per canonical: **earliest start → longest span → lexical**.
   * The first ordered candidate is the assigned brand.

4. **Level 4 — Edge handling**

   * Token edge-punctuation trim (`"beauty:" → "beauty"`).
   * Join-variant matching so `"Baff Bombz"`, `"Baff-Bombz"`, `"Baff_Bombz"` all work.

5. **Level 5 — Reporting**

   * `dryRunBrandAssignment()` returns coverage, unique brand count, and top brands.
   * `--report` and `--report-json` CLI flags to print quick stats.

---

## Algorithms & data structures

* **Graph (adjacency list)**: `Map<string, Set<string>>`

  * Build from `brandConnections.json`, produce synonym components with BFS (or Union-Find).
* **Connected components**: O(V + E); stable and memory-efficient for large alias sets.
* **Canonical selection**: lexicographic by normalized alias; deterministic.
* **Hash maps**:

  * `aliasToCanonical` for O(1) alias resolution during matching.
  * Brand counters for reporting (`Map<string, number>`).
* **Sets**:

  * `STOPWORDS`, `FRONT_ONLY`, `FRONT_OR_SECOND` for O(1) rule checks.
* **Tokenizer**:

  * Normalize, split on space/`-`/`_`, trim edge punctuation, keep an array of tokens.
* **N-gram scan**:

  * Slide 1..4 tokens; try join variants; whole-word regex guard.
* **Deterministic comparator**:

  * Sort candidates: earliest index → longest span → lexical.

---

## Matching rules

* **Front-only** tokens must be the first token.
* **First-or-second** tokens can be at index 0 or 1.
* **HAPPY** must be **uppercase** and at the front in the **raw** title.
* **Stopwords** `BIO`, `NEB` never produce a brand.
* **Diacritics** are folded: `Babē` ≡ `Babe`.
* **Hyphen/underscore** are treated as delimiters and variants are checked in lookups.

**Examples**

* `ULTRA GINKGO …` → `ultra` ✅
* `PARODONTAX … ULTRA CLEAN` → `parodontax` only (mid `ultra` rejected) ✅
* `Gripp-Heel tab. N50` / `Comfort Heel …` → `heel` ✅
* `HAPPY-Care Pack` → `HAPPY` ✅; `happy-Care` → reject ❌
* `Babē Lip Care` → `Babe` ✅
* `ULTRA BEAUTY Cream` → canonical of `ultra beauty` outranks `ultra` (longer span) ✅

---

## Efficiency: before vs after

### Starter code (inefficient)

* For **each product**, looped **all groups** and **all aliases** and ran regex checks:

  * ~O(#aliases) **per product title**
  * With >15k aliases, this scales poorly (`P × A` checks).
* No canonicalization → could assign different synonyms across items.
* No placement/case rules → many **false positives** (e.g., mid-title `ULTRA`).
* No diacritic folding → **missed** matches (`Babē` vs `Babe`).

### Current code (efficient & deterministic)

* **Precompute** `aliasToCanonical` once at startup: ~O(V+E) + linear merge from `brandsMapping.json`.
* **Per product**:

  * Tokenize once: O(T)
  * **N-gram scan** (1..K): ~O(T×K) lookups **in O(1) hash**; K=4 by default
  * Rule gate and whole-word regex only on candidate spans (not on every alias)
* In practice, this reduces checks from **“all aliases per title”** to **“few candidate spans per title”**.
* Deterministic assignment with tie-breaks; synonyms unified to one canonical.

---

## CLI & tests

### Run the demo

```bash
# dry-run report (human readable)
npx ts-node src/main.ts --report

# JSON report
npx ts-node src/main.ts --report-json
```

### Test suite (high level)

```bash
# L2 rules & basic behavior
npx ts-node tests/assignBrandIfKnown.test.ts

# L3 ordering & tie-breakers
npx ts-node tests/assignBrandIfKnown.level3.test.ts

# L4 edge cases (hyphen/underscore, punctuation, numeric, HAPPY, diacritics)
npx ts-node tests/assignBrandIfKnown.level4.edgecases.test.ts

# Live-data E2E with repo JSON (no mocks)
npx ts-node tests/assignBrandIfKnown.live.test.ts
```

---

## Design choices & differences from the starter code

**Starter code**

* Brute-force alias scan: O(P×A) checks.
* `checkBrandIsSeparateTerm` only; no placement/case/stopword rules.
* Selected the **first** matched alias; no deterministic tie-break.
* No canonicalization (risk of storing `zimpli kids` **and** `baff-bombz`).

**This implementation**

* Graph-based synonym groups; **one canonical per group**.
* Fast **alias→canonical** map (hash).
* Rule gate: placement, stopwords, **HAPPY** uppercase, diacritics.
* N-gram scan + delimiter variants + **whole-word** guard.
* Deterministic tie-break: **earliest → longest → lexical**.
* Dry-run metrics & top brands without touching a DB.



