// tests/level1.brand-groups.test.ts
import assert from "assert"
import { getBrandsMapping, oldGetBrandsMapping, checkBrandIsSeparateTerm } from "../src/common/brands"

// optional: if you exported this convenience getter per Level 1
const getAliasToCanonical = () => (getBrandsMapping as any).__aliasToCanonical || {}

function maybeExpectSameCanonical(a2c: Record<string, string>, a: string, b: string) {
  const A = a2c[a.toLowerCase()]
  const B = a2c[b.toLowerCase()]
  if (!A || !B) {
    console.log(`[warn] alias missing in map; skipping:`, { a, b, A, B })
    return
  }
  assert.strictEqual(A, B, `Expected same canonical for "${a}" and "${b}", got ${A} vs ${B}`)
}

(async () => {
  console.log("▶ Level 1 test: building groups & canonicalization")

  const oldMapping = oldGetBrandsMapping();

  const mapping = await getBrandsMapping()
  const a2c: { [normalAlias: string]: string } = getAliasToCanonical()

  // 1) Basic sanity
  // assert.ok(oldMapping && typeof oldMapping === "object", "oldGetBrandsMapping must return an object")
  // const oldGroupCount = Object.keys(oldMapping).length
  // assert.ok(oldGroupCount > 0, "should produce at least 1 group")
  // console.log(" groups:", oldGroupCount)

  assert.ok(mapping && typeof mapping === "object", "getBrandsMapping must return an object")
  const groupCount = Object.keys(mapping).length
  assert.ok(groupCount > 0, "should produce at least 1 group")
  console.log(" groups:", groupCount)

  // 2) Canonical consistency — keys are canonicals
  for (const [canonical, aliases] of Object.entries(mapping)) {
    assert.ok(Array.isArray(aliases), `aliases must be array for ${canonical}`)
    assert.ok(aliases.length > 0, `empty alias list for ${canonical}`)
    // canonical must be in its own alias list
    assert.ok(
      aliases.some(a => a.toLowerCase() === canonical.toLowerCase()),
      `canonical "${canonical}" should appear in its own alias list`
    )
  }

  // 3) Known pairs map to the same canonical (if present)
  const pairs = [
    ["zimpli kids", "baff-bombz"],
    ["heel", "gripp-heel"],
    ["heel", "nervoheel"],
  ]
  for (const [a, b] of pairs) maybeExpectSameCanonical(a2c, a, b)

  // 4) Alias→canonical must point to a canonical that exists as a key
  for (const [aliasNorm, canonical] of Object.entries(a2c)) {
    assert.ok(mapping[canonical], `alias "${aliasNorm}" points to missing canonical "${canonical}"`)
  }

  console.log("✅ Level 1 tests passed.")
})().catch((e) => {
  console.error("❌ Test failed:", e)
  process.exit(1)
})
