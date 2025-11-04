/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Level-3 E2E for assignBrandIfKnown (with Level-2 rules enabled)
 * - Candidate extraction (n-grams)
 * - Tie-breaks (earliest → longest → lexical)
 * - Canonicalization across synonyms
 * - Placement rules, stopwords, HAPPY uppercase, diacritics
 */

import assert from "assert"
import path from "path"

const ROOT = path.resolve(__dirname, "..")
const PHARMACY_JSON = path.resolve(ROOT, "pharmacyItems.json")
const CONNECTIONS_JSON = path.resolve(ROOT, "brandConnections.json")
const BRANDS_MAPPING_JSON = path.resolve(ROOT, "brandsMapping.json") // keep empty; we test using connections

// --- Seed mock datasets BEFORE requiring brands.ts ---
require.cache[PHARMACY_JSON] = {
    id: PHARMACY_JSON,
    filename: PHARMACY_JSON,
    loaded: true,
    exports: [
        // Front-only ULTRA (single + multi-token variants)
        { title: "ULTRA GINKGO & GINSENG, 60 tablečių", source_id: "p1" },

        // First/second HEEL
        { title: "Gripp-Heel tab. N50", source_id: "p2" },
        { title: "Comfort Heel Brand", source_id: "p2b" },
        { title: "Very Comfort Heel Brand", source_id: "p2c" }, // should NOT match (index >= 2)

        // Mid ULTRA (should be ignored), keep parodontax
        { title: "PARODONTAX dantų pasta ULTRA CLEAN, 75ml", source_id: "p3" },

        // Stopwords
        { title: "GENEDENS BIO balinanti pasta", source_id: "p4" },
        { title: "NEB compressor for kids", source_id: "p4b" },

        // HAPPY uppercase vs mixed
        { title: "HAPPY Baby Diapers Size 3", source_id: "p5" },
        { title: "Happy Baby Diapers Size 3", source_id: "p6" },

        // Beginning wins over mid
        { title: "ISDIN FOTOULTRA 100 Spot Prevent", source_id: "p7" },

        // Longest span beats shorter when both start at 0 (across different canonicals)
        { title: "ULTRA BEAUTY Cream", source_id: "p8" }, // 'ultra beauty' (beautyco) vs 'ultra' (vitabiotics)

        // Synonym canonicalization
        { title: "ZIMPLI KIDS Baff Bombz Slime", source_id: "p9" },

        // Diacritics
        { title: "Babē Lip Care 10ml", source_id: "p10" }, // should match 'Babe'
    ],
} as any

require.cache[CONNECTIONS_JSON] = {
    id: CONNECTIONS_JSON,
    filename: CONNECTIONS_JSON,
    loaded: true,
    exports: [
        // Vitabiotics group (ULTRA variants)
        { manufacturer_p1: "vitabiotics", manufacturers_p2: "ultra;ultra ginkgo&ginseng;ultra omega" },

        // Heel group (1st/2nd word allowed by rule layer)
        { manufacturer_p1: "heel", manufacturers_p2: "gripp-heel;heel" },

        // Parodontax
        { manufacturer_p1: "parodontax", manufacturers_p2: "parodontax" },

        // HAPPY
        { manufacturer_p1: "HAPPY", manufacturers_p2: "HAPPY" },

        // Isdin
        { manufacturer_p1: "isdin", manufacturers_p2: "isdin" },

        // Beautyco: multi-token alias "ultra beauty" for tie-break testing
        { manufacturer_p1: "beautyco", manufacturers_p2: "ultra beauty;beauty" },

        // Zimpli kids synonyms
        { manufacturer_p1: "zimpli kids", manufacturers_p2: "zimpli kids;baff-bombz" },

        // Babe (diacritics folding test)
        { manufacturer_p1: "Babe", manufacturers_p2: "Babe" },
    ],
} as any

require.cache[BRANDS_MAPPING_JSON] = {
    id: BRANDS_MAPPING_JSON,
    filename: BRANDS_MAPPING_JSON,
    loaded: true,
    exports: {},
} as any

// After caches are ready, require SUT
const brandsMod = require("../src/common/brands")
const { assignBrandIfKnown } = brandsMod
const { countryCodes } = require("../src/config/enums")
const { sources } = require("../src/sites/sources")

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

function rhs(line: string): string[] {
    const i = line.indexOf("->")
    if (i === -1) return []
    return line.slice(i + 2).trim().split(",").map(s => s.trim()).filter(Boolean)
}

function findLine(logs: string[], titleHas: string): string {
    const line = logs.find(l => l.includes(titleHas))
    assert.ok(line, `Missing log for "${titleHas}"`)
    return line!
}

function has(arr: string[], v: string) {
    const t = v.toLowerCase()
    return arr.some(x => x.toLowerCase() === t)
}

(async () => {
    const { logs } = await captureLogs(async () => {
        await assignBrandIfKnown(countryCodes.lt, sources.APO)
    })

    // 1) Front-only ULTRA → match vitabiotics canonical (likely "ultra")
    {
        const m = rhs(findLine(logs, "ULTRA GINKGO"))
        assert.ok(has(m, "ultra"), `Expected 'ultra', got ${JSON.stringify(m)}`)
    }

    // 2) Heel 1st/2nd positions
    {
        const m1 = rhs(findLine(logs, "Gripp-Heel tab. N50"))
        assert.ok(has(m1, "gripp-heel") || has(m1, "heel"), `Expected heel canonical, got ${JSON.stringify(m1)}`)

        const m2 = rhs(findLine(logs, "Comfort Heel Brand"))
        assert.ok(has(m2, "gripp-heel") || has(m2, "heel"), `Expected heel canonical at 2nd word, got ${JSON.stringify(m2)}`)

        const m3 = rhs(findLine(logs, "Very Comfort Heel Brand"))
        assert.ok(m3.length === 0, `Expected NO heel at index>=2, got ${JSON.stringify(m3)}`)
    }

    // 3) Mid-string ULTRA ignored; keep parodontax
    {
        const m = rhs(findLine(logs, "PARODONTAX dantų pasta"))
        assert.ok(has(m, "parodontax"), `Expected parodontax, got ${JSON.stringify(m)}`)
        assert.ok(!has(m, "ultra"), `Did NOT expect 'ultra' mid-string, got ${JSON.stringify(m)}`)
    }

    // 4) Stopwords BIO/NEB ignored
    {
        const mBio = rhs(findLine(logs, "GENEDENS BIO"))
        assert.ok(mBio.length === 0 || !has(mBio, "bio"), `Did NOT expect 'bio', got ${JSON.stringify(mBio)}`)

        const mNeb = rhs(findLine(logs, "NEB compressor"))
        assert.ok(mNeb.length === 0 || !has(mNeb, "neb"), `Did NOT expect 'neb', got ${JSON.stringify(mNeb)}`)
    }

    // 5) HAPPY uppercase vs mixed
    {
        const m1 = rhs(findLine(logs, "HAPPY Baby"))
        assert.ok(has(m1, "HAPPY"), `Expected 'HAPPY', got ${JSON.stringify(m1)}`)

        const m2 = rhs(findLine(logs, "Happy Baby"))
        assert.ok(!has(m2, "HAPPY"), `Did NOT expect 'HAPPY' for mixed case, got ${JSON.stringify(m2)}`)
    }

    // 6) Beginning wins vs mid: ISDIN vs ULTRA inside FOTOULTRA
    {
        const m = rhs(findLine(logs, "ISDIN FOTOULTRA"))
        assert.ok(has(m, "isdin"), `Expected 'isdin' as earliest start, got ${JSON.stringify(m)}`)
        assert.ok(!has(m, "ultra"), `Should not surface 'ultra' mid token as higher, got ${JSON.stringify(m)}`)
    }

    // 7) Longest span beats shorter (both start at index 0): 'ultra beauty' vs 'ultra'
    // Canonical for ['ultra beauty','beauty','beautyco'] is chosen lexicographically = 'beauty'.
    {
        const m = rhs(findLine(logs, "ULTRA BEAUTY Cream"))
        // Expect 'beauty' (canonical of the 'ultra beauty' group) ahead of 'ultra'
        assert.ok(has(m, "beauty"), `Expected 'beauty' (canonical of 'ultra beauty'), got ${JSON.stringify(m)}`)
        // And ensure 'ultra' can still appear later, but not ahead of 'beauty'
        assert.ok(m.indexOf("beauty") !== -1, `Expected 'beauty' in list, got ${JSON.stringify(m)}`)
        if (has(m, "ultra")) {
            assert.ok(m.indexOf("beauty") < m.indexOf("ultra"),
                `Expected 'beauty' (2-token) to outrank 'ultra' (1-token); got ${JSON.stringify(m)}`)
        }
    }


    // 8) Synonyms collapse to one canonical
    {
        const m = rhs(findLine(logs, "ZIMPLI KIDS Baff Bombz"))
        // Canonical is lexicographic of the group; accept either
        assert.ok(has(m, "zimpli kids") || has(m, "baff-bombz"), `Expected one canonical of the pair, got ${JSON.stringify(m)}`)
    }

    // 9) Diacritics: Babē → Babe
    {
        const m = rhs(findLine(logs, "Babē Lip Care"))
        assert.ok(has(m, "Babe") || has(m, "babe"), `Expected 'Babe' via diacritic fold, got ${JSON.stringify(m)}`)
    }

    console.log("✅ Level 3 assertions passed.")
})().catch(e => {
    console.error("❌ Test failed:", e)
    process.exit(1)
})
