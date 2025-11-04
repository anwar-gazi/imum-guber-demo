/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Level 2 test for assignBrandIfKnown:
 * - Front-only tokens (ultra, happy, etc.)
 * - 1st/2nd word tokens (heel, contour, nero, rsv)
 * - Stopwords (BIO, NEB) ignored
 * - HAPPY must be uppercase and at front
 * - Assertions operate ONLY on the RHS of the log ("title -> matches")
 */

import assert from "assert"
import path from "path"

const ROOT = path.resolve(__dirname, "..")
const PHARMACY_JSON = path.resolve(ROOT, "pharmacyItems.json")
const CONNECTIONS_JSON = path.resolve(ROOT, "brandConnections.json")
const BRANDS_MAPPING_JSON = path.resolve(ROOT, "brandsMapping.json") // optional enrichment

// --- Mock data (seed before requiring brands.ts) ---
require.cache[PHARMACY_JSON] = {
  id: PHARMACY_JSON,
  filename: PHARMACY_JSON,
  loaded: true,
  exports: [
    { title: "ULTRA GINKGO & GINSENG, 60 tablečių", source_id: "p1" },      // front-only ULTRA -> allowed
    { title: "Gripp-Heel tab. N50", source_id: "p2" },                       // 1st/2nd word HEEL -> allowed
    { title: "PARODONTAX dantų pasta ULTRA CLEAN, 75ml", source_id: "p3" },  // mid-string ULTRA -> must be ignored
    { title: "GENEDENS BIO balinanti pasta", source_id: "p4" },              // BIO stopword -> ignored
    { title: "HAPPY Baby Diapers Size 3", source_id: "p5" },                 // HAPPY uppercase at front -> allowed
    { title: "Happy Baby Diapers Size 3", source_id: "p6" },                 // mixed-case happy -> NOT allowed
  ],
} as any

require.cache[CONNECTIONS_JSON] = {
  id: CONNECTIONS_JSON,
  filename: CONNECTIONS_JSON,
  loaded: true,
  exports: [
    { manufacturer_p1: "vitabiotics", manufacturers_p2: "ultra;ultra ginkgo&ginseng;ultra omega" },
    { manufacturer_p1: "heel", manufacturers_p2: "gripp-heel;heel" },
    { manufacturer_p1: "parodontax", manufacturers_p2: "parodontax" },
    { manufacturer_p1: "HAPPY", manufacturers_p2: "HAPPY" },
  ],
} as any

require.cache[BRANDS_MAPPING_JSON] = {
  id: BRANDS_MAPPING_JSON,
  filename: BRANDS_MAPPING_JSON,
  loaded: true,
  exports: {},
} as any

const brandsMod = require("../src/common/brands")
const { assignBrandIfKnown } = brandsMod
const { countryCodes } = require("../src/config/enums")
const { sources } = require("../src/sites/sources")

// --- Utilities ---
function captureLogs<T>(fn: () => Promise<T>) {
  const logs: string[] = []
  const orig = console.log
  console.log = (...args: any[]) => {
    const line = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")
    logs.push(line)
    orig.apply(console, args)
  }
  return fn()
    .then(res => {
      console.log = orig
      return { res, logs }
    })
    .catch(err => {
      console.log = orig
      throw err
    })
}

// Parse "title -> a,b,c" and return an array of matched brand strings on RHS
function parseMatchedBrands(line: string): string[] {
  const idx = line.indexOf("->")
  if (idx === -1) return []
  const rhs = line.slice(idx + 2).trim()
  if (!rhs) return []
  // If lodash printed an array, it may look like "a,b,c" (no brackets) — split by comma.
  return rhs.split(",").map(s => s.trim()).filter(Boolean)
}

function findLine(logs: string[], titleContains: string): string {
  const line = logs.find(l => l.includes(titleContains))
  assert.ok(line, `Missing log for "${titleContains}"`)
  return line!
}

function includesCI(arr: string[], target: string) {
  const t = target.toLowerCase()
  return arr.some(x => x.toLowerCase() === t)
}

// --- Tests ---
;(async () => {
  console.log("▶ Level 2 test: assignBrandIfKnown (RHS-only assertions)…")

  const { logs } = await captureLogs(async () => {
    await assignBrandIfKnown(countryCodes.lt, sources.APO)
  })

  // 1) ULTRA at front → allowed (canonical likely 'ultra')
  {
    const line = findLine(logs, "ULTRA GINKGO")
    const matches = parseMatchedBrands(line)
    assert.ok(includesCI(matches, "ultra"), `Expected canonical 'ultra' in matches; got ${JSON.stringify(matches)}`)
  }

  // 2) Gripp-Heel → allowed at 1st/2nd; canonical can be 'gripp-heel' OR 'heel'
  {
    const line = findLine(logs, "Gripp-Heel tab. N50")
    const matches = parseMatchedBrands(line)
    assert.ok(
      includesCI(matches, "gripp-heel") || includesCI(matches, "heel"),
      `Expected 'gripp-heel' or 'heel'; got ${JSON.stringify(matches)}`
    )
  }

  // 3) PARODONTAX … ULTRA CLEAN → ULTRA mid-string should be ignored; keep 'parodontax' only
  {
    const line = findLine(logs, "PARODONTAX dantų pasta")
    const matches = parseMatchedBrands(line)
    assert.ok(includesCI(matches, "parodontax"), `Expected 'parodontax' in matches; got ${JSON.stringify(matches)}`)
    assert.ok(!includesCI(matches, "ultra"), `Did NOT expect 'ultra' for mid-string ULTRA; got ${JSON.stringify(matches)}`)
  }

  // 4) GENEDENS BIO … → 'bio' is a stopword → should NOT appear
  {
    const line = findLine(logs, "GENEDENS BIO")
    const matches = parseMatchedBrands(line)
    assert.ok(matches.length === 0 || !includesCI(matches, "bio"), `Did NOT expect 'bio'; got ${JSON.stringify(matches)}`)
  }

  // 5) HAPPY uppercase at front → allowed
  {
    const line = findLine(logs, "HAPPY Baby Diapers Size 3")
    const matches = parseMatchedBrands(line)
    assert.ok(includesCI(matches, "HAPPY"), `Expected 'HAPPY' in matches; got ${JSON.stringify(matches)}`)
  }

  // 6) Mixed-case Happy at front → NOT allowed
  {
    const line = findLine(logs, "Happy Baby Diapers Size 3")
    const matches = parseMatchedBrands(line)
    assert.ok(!includesCI(matches, "HAPPY"), `Did NOT expect 'HAPPY' for mixed-case; got ${JSON.stringify(matches)}`)
  }

  console.log("✅ Level 2 assertions passed.")
})().catch(e => {
  console.error("❌ Test failed:", e)
  process.exit(1)
})
