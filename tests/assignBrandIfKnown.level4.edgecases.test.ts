/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Level 4 edge-case tests:
 *  - Hyphen/underscore tokenization
 *  - Numeric front-only token ("112")
 *  - Punctuation boundaries
 *  - HAPPY uppercase with hyphen
 *  - Diacritics (alias vs title, both directions)
 *  - Multi-token front-only alias not at front (reject)
 *  - Synonym canonicalization
 */

import assert from "assert"
import path from "path"

const ROOT = path.resolve(__dirname, "..")
const PHARMACY_JSON = path.resolve(ROOT, "pharmacyItems.json")
const CONNECTIONS_JSON = path.resolve(ROOT, "brandConnections.json")
const BRANDS_MAPPING_JSON = path.resolve(ROOT, "brandsMapping.json")

// --- Mock data (seed BEFORE requiring brands.ts) ---
require.cache[PHARMACY_JSON] = {
  id: PHARMACY_JSON,
  filename: PHARMACY_JSON,
  loaded: true,
  exports: [
    // 1) Hyphen at front: ULTRA should count at index 0
    { title: "ULTRA-CLEAN Whitening Gel", source_id: "e1" },

    // 2) Underscore mid: ULTRA appears but not at front → must be ignored
    { title: "PARODONTAX_ULTRA_CLEAN Mint", source_id: "e2" },

    // 3) Numeric front-only token
    { title: "112 Face Wash 100ml", source_id: "e3" },

    // 4) Punctuation boundary at front with front-only "beauty"
    { title: "Beauty: ULTRA Gel", source_id: "e4" },

    // 5) HAPPY with hyphen (uppercase) vs mixed-case
    { title: "HAPPY-Care Pack", source_id: "e5" },
    { title: "happy-Care Pack", source_id: "e6" },

    // 6) Diacritics: alias has diacritic, title plain
    { title: "Babe Intensive Lip Care", source_id: "e7" },
    // 7) Diacritics reversed: title has diacritic, alias plain
    { title: "Babē Repair Cream", source_id: "e8" },

    // 8) Multi-token front-only alias not at front (reject 'ultra beauty')
    { title: "Cream ULTRA BEAUTY Pack", source_id: "e9" },

    // 9) Synonym canonicalization
    { title: "Baff-Bombz Mega Pack", source_id: "e10" },
  ],
} as any

require.cache[CONNECTIONS_JSON] = {
  id: CONNECTIONS_JSON,
  filename: CONNECTIONS_JSON,
  loaded: true,
  exports: [
    // Vitabiotics group with ULTRA variants
    { manufacturer_p1: "vitabiotics", manufacturers_p2: "ultra;ultra ginkgo&ginseng;ultra omega" },

    // Parodontax singleton
    { manufacturer_p1: "parodontax", manufacturers_p2: "parodontax" },

    // Numeric brand "112"
    { manufacturer_p1: "112", manufacturers_p2: "112" },

    // Beautyco group: single- and multi-token aliases
    { manufacturer_p1: "beautyco", manufacturers_p2: "beauty;ultra beauty" },

    // HAPPY singleton
    { manufacturer_p1: "HAPPY", manufacturers_p2: "HAPPY" },

    // Babe (diacritics)
    { manufacturer_p1: "Babe", manufacturers_p2: "Babe;Babē" },

    // Zimpli kids synonyms
    { manufacturer_p1: "zimpli kids", manufacturers_p2: "zimpli kids;baff-bombz" },
  ],
} as any

// Keep external brandsMapping empty (we rely on connections)
require.cache[BRANDS_MAPPING_JSON] = {
  id: BRANDS_MAPPING_JSON,
  filename: BRANDS_MAPPING_JSON,
  loaded: true,
  exports: {},
} as any

// Require SUT after cache seeding
const brandsMod = require("../src/common/brands")
const { assignBrandIfKnown } = brandsMod
const { countryCodes } = require("../src/config/enums")
const { sources } = require("../src/sites/sources")

// --- Helpers ---
function captureLogs<T>(fn: () => Promise<T>) {
  const logs: string[] = []
  const orig = console.log
  console.log = (...args: any[]) => {
    const line = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")
    logs.push(line)
    orig.apply(console, args)
  }
  return fn()
    .then(res => { console.log = orig; return { res, logs } })
    .catch(err => { console.log = orig; throw err })
}

function rhs(line: string): string[] {
  const i = line.indexOf("->")
  if (i === -1) return []
  return line.slice(i + 2).trim().split(",").map(s => s.trim()).filter(Boolean)
}

function findLine(logs: string[], titleHas: string) {
  const line = logs.find(l => l.includes(titleHas))
  assert.ok(line, `Missing log for "${titleHas}"`)
  return line!
}

function has(arr: string[], v: string) {
  const t = v.toLowerCase()
  return arr.some(x => x.toLowerCase() === t)
}

// --- Tests ---
;(async () => {
  const { logs } = await captureLogs(async () => {
    await assignBrandIfKnown(countryCodes.lt, sources.APO)
  })

  // 1) ULTRA-CLEAN at front → ULTRA allowed
  {
    const m = rhs(findLine(logs, "ULTRA-CLEAN"))
    assert.ok(has(m, "ultra"), `Expected 'ultra', got ${JSON.stringify(m)}`)
  }

  // 2) PARODONTAX_ULTRA_CLEAN → ULTRA mid (index 1) → ignore; keep parodontax if present
  {
    const m = rhs(findLine(logs, "PARODONTAX_ULTRA_CLEAN"))
    // We accept either only 'parodontax' or empty (if not matched due to formatting),
    // but MUST NOT contain 'ultra'
    assert.ok(!has(m, "ultra"), `Did NOT expect 'ultra' mid/underscore, got ${JSON.stringify(m)}`)
  }

  // 3) Numeric front "112"
  {
    const m = rhs(findLine(logs, "112 Face Wash"))
    assert.ok(has(m, "112"), `Expected '112', got ${JSON.stringify(m)}`)
  }

  // 4) Punctuation boundary: "Beauty: ..." → beauty is front-only and allowed at index 0
  {
    const m = rhs(findLine(logs, "Beauty: ULTRA"))
    assert.ok(has(m, "beauty") || has(m, "beautyco"), `Expected beauty canonical, got ${JSON.stringify(m)}`)
  }

  // 5) HAPPY uppercase with hyphen vs mixed-case
  {
    const m1 = rhs(findLine(logs, "HAPPY-Care"))
    assert.ok(has(m1, "HAPPY"), `Expected 'HAPPY', got ${JSON.stringify(m1)}`)
    const m2 = rhs(findLine(logs, "happy-Care"))
    assert.ok(!has(m2, "HAPPY"), `Did NOT expect 'HAPPY' for mixed-case, got ${JSON.stringify(m2)}`)
  }

  // 6) Diacritics: alias has diacritic, title plain
  {
    const m = rhs(findLine(logs, "Babe Intensive Lip Care"))
    assert.ok(has(m, "Babe") || has(m, "babe"), `Expected 'Babe' via diacritic fold, got ${JSON.stringify(m)}`)
  }

  // 7) Diacritics reversed: title has diacritic, alias plain
  {
    const m = rhs(findLine(logs, "Babē Repair Cream"))
    assert.ok(has(m, "Babe") || has(m, "babe"), `Expected 'Babe' via diacritic fold, got ${JSON.stringify(m)}`)
  }

  // 8) Multi-token alias not at front: "Cream ULTRA BEAUTY Pack" → reject 'ultra beauty'
  {
    const m = rhs(findLine(logs, "Cream ULTRA BEAUTY"))
    assert.ok(!has(m, "beauty") && !has(m, "beautyco"),
      `Did NOT expect 'ultra beauty' group when not at front, got ${JSON.stringify(m)}`)
  }

  // 9) Canonicalization of synonyms for Baff-Bombz
  {
    const m = rhs(findLine(logs, "Baff-Bombz Mega Pack"))
    assert.ok(has(m, "zimpli kids") || has(m, "baff-bombz"),
      `Expected one canonical of baff-bombz/zimpli kids, got ${JSON.stringify(m)}`)
  }

  console.log("✅ Level 4 edge cases passed.")
})().catch(e => {
  console.error("❌ Test failed:", e)
  process.exit(1)
})
