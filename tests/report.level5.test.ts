/* eslint-disable @typescript-eslint/no-var-requires */
import assert from "assert"
import path from "path"

const ROOT = path.resolve(__dirname, "..")
const PHARMACY_JSON = path.resolve(ROOT, "pharmacyItems.json")
const CONNECTIONS_JSON = path.resolve(ROOT, "brandConnections.json")
const BRANDS_MAPPING_JSON = path.resolve(ROOT, "brandsMapping.json")

// Small sample to validate metrics wiring (reuse patterns from earlier tests)
require.cache[PHARMACY_JSON] = {
  id: PHARMACY_JSON,
  filename: PHARMACY_JSON,
  loaded: true,
  exports: [
    { title: "ULTRA GINKGO & GINSENG, 60 tablečių", source_id: "r1" },
    { title: "Gripp-Heel tab. N50", source_id: "r2" },
    { title: "PARODONTAX dantų pasta ULTRA CLEAN, 75ml", source_id: "r3" },
    { title: "GENEDENS BIO balinanti pasta", source_id: "r4" },
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
  ],
} as any

require.cache[BRANDS_MAPPING_JSON] = {
  id: BRANDS_MAPPING_JSON,
  filename: BRANDS_MAPPING_JSON,
  loaded: true,
  exports: {},
} as any

const { dryRunBrandAssignment } = require("../src/common/brands")
const { countryCodes } = require("../src/config/enums")
const { sources } = require("../src/sites/sources")

;(async () => {
  const report = await dryRunBrandAssignment(countryCodes.lt, sources.APO)

  assert.strictEqual(report.total, 4)
  // Expected chosen (based on Level-2/3): ULTRA, HEEL, PARODONTAX, (BIO ignored)
  assert.ok(report.assigned >= 2, "Expected at least 2 assigned in sample")
  assert.ok(report.uniqueBrands >= 2, "Expected at least 2 unique brands")

  // Top brands contain at least 'ultra' or 'heel' depending on canonical choice
  const names = report.byBrand.map(x => x.brand.toLowerCase())
  assert.ok(names.includes("ultra") || names.includes("gripp-heel") || names.includes("heel"),
    "Expected 'ultra' or 'heel' in top brands")

  // rows integrity
  assert.ok(Array.isArray(report.rows) && report.rows.length === 4)
  assert.ok(report.rows.every(r => "title" in r && "matches" in r && "chosen" in r))

  // eslint-disable-next-line no-console
  console.log("✅ Level 5 report tests passed.")
})().catch(e => {
  // eslint-disable-next-line no-console
  console.error("❌ Level 5 report tests failed:", e)
  process.exit(1)
})
