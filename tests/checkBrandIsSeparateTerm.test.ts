import assert from "assert"
import { checkBrandIsSeparateTerm } from "../src/common/brands"

// Helper to run one test and print a friendly line
function t(input: string, brand: string, expected: boolean, note = "") {
  const got = checkBrandIsSeparateTerm(input, brand)
  const ok = got === expected
  const pad = ok ? "✅" : "❌"
  const msg = `${pad} ${JSON.stringify({ input, brand, expected, got })}${note ? "  // " + note : ""}`
  console.log(msg)
  assert.strictEqual(got, expected)
}

(async () => {
  console.log("▶ checkBrandIsSeparateTerm — current behavior tests")

  // --- Matches as separate whole word (beginning/middle/end) ---
  t("GUM Travel soft Dantų šepetėlis", "gum", true, "whole word at beginning")
  t("Parodontax gum paste 75ml", "gum", true, "whole word in middle")
  t("Parodontax whitening gum", "gum", true, "whole word at end")

  // --- Does NOT match as substring ---
  t("sugar crystals 75g", "gum", false, "substring only — should NOT match")

  // --- Hyphen boundaries act as word boundaries in JS regex ---
  t("Gripp-Heel tab. N50", "heel", true, "hyphen-delimited counts as boundary")

  // --- Punctuation boundaries also act as word boundaries ---
  t("Beauty, Ultra Clean formula", "ultra", true, "comma/space -> boundary")

  // --- Case-insensitive today (NOTE: differs from future HAPPY rule) ---
  t("Happy Baby diapers", "HAPPY", true, "current fn is case-insensitive")
  t("HAPPY Baby diapers", "HAPPY", true, "upper also matches (expected)")

  // --- Diacritics are NOT folded today (Babē ≠ Babe) ---
  t("Babē Lip Care 10ml", "Babe", false, "no diacritic folding in current fn")

  // --- Stopword BIO currently matches as a word (you’ll filter later) ---
  t("GENEDENS BIO balinanti pasta", "BIO", true, "current fn would match BIO")

  // --- Position rules are NOT enforced here (front/second) ---
  t("PARODONTAX dantų pasta ULTRA CLEAN 75ml", "ULTRA", true, "current fn ignores front-only rule")

  console.log("✅ All assertions passed for current implementation.")
})().catch(e => {
  console.error("❌ Test failed:", e)
  process.exit(1)
})
