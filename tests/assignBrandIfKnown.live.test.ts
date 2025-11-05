/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Live-data E2E: uses the real JSON files in the repo.
 * Verifies:
 *  - getBrandsMapping builds non-empty canonical groups
 *  - alias->canonical cache exists and is consistent with mapping
 *  - dryRunBrandAssignment stats are sane and rows are well-formed
 *  - assignBrandIfKnown runs and logs canonical matches only (no duplicates)
 */

import assert from "assert"
import path from "path"

// Import SUT (will load live JSONs via the module)
const { getBrandsMapping, dryRunBrandAssignment } = require("../src/common/brands")
const { countryCodes } = require("../src/config/enums")
const { sources } = require("../src/sites/sources")

// Also read live pharmacyItems.json to compare totals
const PHARMACY_JSON = path.resolve(__dirname, "..", "pharmacyItems.json")
const pharmacyItems = require(PHARMACY_JSON)

// Helper: capture console.log during assignBrandIfKnown
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

// Parse "title -> a,b,c" and return RHS matches as array
function parseMatches(line: string): string[] {
    const i = line.indexOf("->")
    if (i === -1) return []
    return line.slice(i + 2).trim().split(",").map(s => s.trim()).filter(Boolean)
}

// Main runner
; (async () => {
    // 1) Mapping & alias cache sanity
    const mapping = await getBrandsMapping()
    const aliasToCanonical = (getBrandsMapping as any).__aliasToCanonical || {}

    const canonicals = Object.keys(mapping)
    assert.ok(canonicals.length > 0, "Expected non-empty canonical mapping")
    assert.ok(Object.keys(aliasToCanonical).length > 0, "Expected non-empty alias->canonical cache")

    // canonical must appear in its own alias list; alias->canonical must point to an existing canonical
    for (const c of canonicals.slice(0, 200)) { // sample up to 200 to keep it quick
        const aliases: string[] = mapping[c]
        assert.ok(Array.isArray(aliases) && aliases.length > 0, `Aliases must be non-empty for ${c}`)
        const hasSelf = aliases.some(a => a.toLowerCase() === c.toLowerCase())
        assert.ok(hasSelf, `Canonical "${c}" should be present in its alias list`)
        for (const a of aliases.slice(0, 50)) { // sample
            const norm = (a || "").toString().normalize().toLowerCase().trim()
            const can = aliasToCanonical[norm]
            assert.ok(!can || canonicals.includes(can), `Alias "${a}" maps to unknown canonical "${can}"`)
        }
    }

    // 2) Dry-run report: totals & structure
    const report = await dryRunBrandAssignment(countryCodes.lt, sources.APO)
    assert.strictEqual(report.total, pharmacyItems.length, "Report total should match live pharmacyItems length")
    assert.ok(report.assigned <= report.total, "Assigned cannot exceed total")
    assert.ok(report.uniqueBrands <= report.assigned, "Unique brands cannot exceed assigned count")
    assert.ok(Array.isArray(report.byBrand), "byBrand must be an array")
    // byBrand sorted descending (if there are at least 2)
    if (report.byBrand.length >= 2) {
        assert.ok(report.byBrand.every((x: any) => typeof x.brand === "string" && typeof x.count === "number"),
            "Each byBrand item must be {brand, count}")
        for (let i = 1; i < report.byBrand.length; i++) {
            assert.ok(report.byBrand[i - 1].count >= report.byBrand[i].count, "byBrand must be sorted desc by count")
        }
    }
    // rows integrity
    assert.ok(Array.isArray(report.rows) && report.rows.length === report.total, "rows must cover all items")
    for (const r of report.rows.slice(0, 200)) { // sample
        assert.ok(typeof r.title === "string", "row.title must be string")
        assert.ok(Array.isArray(r.matches), "row.matches must be array")
        if (r.chosen) {
            assert.strictEqual(r.chosen, r.matches[0], "chosen must be the first of matches")
            assert.ok(canonicals.includes(r.chosen), "chosen must be a canonical key")
        }
    }

    // 3) assignBrandIfKnown should log canonical names only, with no duplicates
    const brandsMod = require("../src/common/brands")
    const { assignBrandIfKnown } = brandsMod
    const { logs } = await captureLogs(async () => {
        await assignBrandIfKnown(countryCodes.lt, sources.APO)
    })

    // Validate a sample of log lines
    const lines = logs.filter(l => l.includes("->")).slice(0, 200)
    for (const line of lines) {
        const matches = parseMatches(line)
        // All matches must be canonicals (keys in mapping)
        for (const m of matches) {
            assert.ok(canonicals.includes(m), `Logged match "${m}" should be a canonical key`)
        }
        // No duplicates
        const set = new Set(matches.map(x => x.toLowerCase()))
        assert.strictEqual(set.size, matches.length, "Logged matches should have no duplicates")
    }

    // eslint-disable-next-line no-console
    console.log("✅ Live-data tests passed. Items:", report.total, "Assigned:", report.assigned, "Unique brands:", report.uniqueBrands)
})().catch(e => {
    // eslint-disable-next-line no-console
    console.error("❌ Live-data test failed:", e)
    process.exit(1)
})
