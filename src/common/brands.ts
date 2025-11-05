import { Job } from "bullmq"
import { countryCodes, dbServers, EngineType } from "../config/enums"
import { ContextType } from "../libs/logger"
import { jsonOrStringForDb, jsonOrStringToJson, stringOrNullForDb, stringToHash } from "../utils"
import _ from "lodash"
import { sources } from "../sites/sources"
import items from "./../../pharmacyItems.json"

type BrandsMapping = Record<string, string[]>;
type UndirectedGraph = Map<string, Set<string>>;
type ExternalBrandsMapping = Record<string, string[]>;
type BrandConnections = {
    manufacturer_p1: string,
    manufacturers_p2: string
};

let connections: BrandConnections[];
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    connections = require("./../../brandConnections.json")
    if (!connections || typeof connections !== "object") {
        throw new Error("brandConnections.json exists but is not a valid JSON object")
    }
} catch (e) {
    throw new Error(
        "brandConnections.json is required but was not found. " +
        "Place it at project root and ensure it exports an object { aliasKey: string[] }."
    )
}

let externalBrandsMapping: ExternalBrandsMapping;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    externalBrandsMapping = require("./../../brandsMapping.json")
    if (!externalBrandsMapping || typeof externalBrandsMapping !== "object") {
        throw new Error("brandsMapping.json exists but is not a valid JSON object")
    }
} catch (e) {
    throw new Error(
        "brandsMapping.json is required but was not found. " +
        "Place it at project root and ensure it exports an object { aliasKey: string[] }."
    )
}

// --- Level 2 helpers: normalization + rule gate ---

const STOPWORDS = new Set(["bio", "neb"])
const FRONT_ONLY = new Set(["rich", "rff", "flex", "ultra", "gum", "beauty", "orto", "free", "112", "kin", "happy"])
const FRONT_OR_SECOND = new Set(["heel", "contour", "nero", "rsv"])

/**
 * normalize a product title
 * @param s title
 * @returns normalized name
 */
function normalizeName(s: string): string {
    return _.deburr(String(s || "")).toLowerCase().replace(/\s+/g, " ").trim();
}

// This enforces placement, stopwords, and HAPPY uppercase.
// rawInput is the original title (we need it for the HAPPY case).
function passesPlacementAndCaseRules(rawInput: string, brandAlias: string): boolean {
    const normBrand = normalizeName(brandAlias)
    if (!normBrand) return false

    // 1) Stopwords never trigger a brand
    if (STOPWORDS.has(normBrand)) return false

    // Identify the first token of the alias
    const firstToken = normBrand.split(/[^a-z0-9]+/i).filter(Boolean)[0] || normBrand

    // 2) HAPPY must be uppercase at the front of the RAW input
    if (firstToken === "happy") {
        // Require EXACT "HAPPY" at start (hyphen/word boundary allowed)
        if (!/^(?:HAPPY)(?:\b|[-_])/.test(String(rawInput || ""))) return false
        // And because "happy" is also in FRONT_ONLY, it must be at index 0 (handled below)
    }

    // Prepare a diacritic-folded raw string for placement checks (case-insensitive)
    const fold = _.deburr(String(rawInput || ""))

    // 3) Front-only tokens must be at index 0
    if (FRONT_ONLY.has(firstToken)) {
        // Accept start of string, followed by word boundary or hyphen/underscore
        const re = new RegExp(`^(?:${firstToken})(?:\\b|[-_])`, "i")
        return re.test(fold)
    }

    // 4) Front-or-second tokens (exact single-token brands)
    //    Accept either at start, or right after the first token (hyphen or space as delimiter).
    if (FRONT_OR_SECOND.has(normBrand)) {
        const re = new RegExp(`^(?:${normBrand}\\b|\\S+[\\s-]+${normBrand}\\b)`, "i")
        return re.test(fold)
    }

    // 5) Otherwise, no special placement restriction
    return true
}

// --- Level 3: tokenization, n-gram candidate search, tie-break ordering ---

const MAX_NGRAM_TOKENS = 4

/**
 * Tokenize a raw title for matching.
 * - Diacritic fold + lowercase via normalizeName()
 * - Treat spaces, hyphens, underscores as delimiters
 * - Trim leading/trailing punctuation from each token (e.g., "beauty:" → "beauty")
 */
function tokenizeForMatch(rawTitle: string): string[] {
    // split on space; first convert hyphen/underscore to space
    const norm = normalizeName(rawTitle).replace(/[-_]/g, " ")
    const rawTokens = norm.split(" ").filter(Boolean)
    // strip punctuation at token edges but keep inner punctuation (so we don't break things like "ginkgo&ginseng")
    const tokens = rawTokens
        .map(t => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, ""))
        .filter(Boolean)
    return tokens
}


/**
 * Find brand candidates using a sliding n-gram over tokens.
 * Applies:
 *  - alias→canonical lookup
 *  - whole-word boundary safeguard
 *  - placement/case rules (Level-2 gate)
 *
 * For each canonical, keeps the best metrics (earliest start, then longest span).
 *
 * @param rawTitle Original product title (raw, not normalized)
 * @param aliasToCanonical Map of normalized alias → canonical brand name
 * @returns Map<canonical, { startIdx: number, spanLen: number }>
 */
function findAliasCandidates(
    rawTitle: string,
    aliasToCanonical: { [alias: string]: string }
): Map<string, { startIdx: number; spanLen: number }> {
    const tokens = tokenizeForMatch(rawTitle)
    const candidates = new Map<string, { startIdx: number; spanLen: number }>()

    for (let i = 0; i < tokens.length; i++) {
        for (let len = 1; len <= MAX_NGRAM_TOKENS && i + len <= tokens.length; len++) {
            const spanTokens = tokens.slice(i, i + len)

            // NEW: try multiple join variants to match alias index
            const variants = [
                spanTokens.join(" "),
                spanTokens.join("-"),
                spanTokens.join("_"),
            ]

            for (const variant of variants) {
                const canonical = aliasToCanonical[variant]
                if (!canonical) continue

                // Whole-word + rule gate checks use the *raw* title and the found alias string
                const wholeWord = checkBrandIsSeparateTerm(_.deburr(rawTitle), variant)
                if (!wholeWord) continue
                if (!passesPlacementAndCaseRules(rawTitle, variant)) continue

                const prev = candidates.get(canonical)
                if (
                    !prev ||
                    i < prev.startIdx ||
                    (i === prev.startIdx && len > prev.spanLen)
                ) {
                    candidates.set(canonical, { startIdx: i, spanLen: len })
                }

                // Important: once a variant matched for this (i,len), no need to test other variants
                break
            }
        }
    }

    return candidates
}

/**
 * Order canonical candidates by:
 *  1) smallest startIdx (earliest in title wins)
 *  2) largest spanLen   (longest phrase wins)
 *  3) lexical canonical (deterministic fallback)
 *
 * @param candidates Map of canonical → {startIdx, spanLen}
 * @returns Ordered list of canonical names (best first)
 */
function orderCandidates(
    candidates: Map<string, { startIdx: number; spanLen: number }>
): string[] {
    const rows = Array.from(candidates.entries())
    rows.sort((a, b) => {
        const A = a[1], B = b[1]
        if (A.startIdx !== B.startIdx) return A.startIdx - B.startIdx
        if (A.spanLen !== B.spanLen) return B.spanLen - A.spanLen
        const an = normalizeName(a[0]), bn = normalizeName(b[0])
        return an < bn ? -1 : an > bn ? 1 : 0
    })
    return rows.map(([canonical]) => canonical)
}


/**
 * Build and undirected adjacency list from brandConnections.json
 * @param connectionsList 
 * @returns 
 */
function buildGraph(connectionsList: any[]): UndirectedGraph {
    const g = new Map<string, Set<string>>();

    function addNode(n: string) {
        if (!g.has(n)) g.set(n, new Set<string>());
    }

    function addEdge(a: string, b: string) {
        addNode(a); addNode(b);
        g.get(a)!.add(b);
        g.get(b)!.add(a);
    }

    for (const row of connectionsList || []) {
        const p1Raw = row?.manufacturer_p1;
        const p2Raw = row?.manufacturers_p2;
        if (!p1Raw || !p2Raw) continue;

        const p1 = p1Raw.toString();
        addNode(p1);

        for (const p2 of p2Raw.toString().split(";")) {
            const alias = p2.trim();
            if (!alias) continue;
            addEdge(p1, alias);
        }
    }
    return g;
}

/**
 * find connected components (each = one synonym group)
 * Graph teaversal with BFS
 * @param g 
 * @returns 
 */
function components(g: UndirectedGraph): string[][] {
    const seen = new Set<string>();
    const groups: string[][] = []; // alias clusters

    for (const start of g.keys()) {
        if (seen.has(start)) continue
        const q = [start]
        const comp: string[] = []
        seen.add(start)

        while (q.length) {
            const v = q.shift()!
            comp.push(v)
            for (const nxt of (g.get(v) || [])) {
                if (!seen.has(nxt)) {
                    seen.add(nxt)
                    q.push(nxt)
                }
            }
        }
        groups.push(comp)
    }
    return groups;
}

/**
 * Pick a canonical: lexicographically smallest by normalized string but return the original case name for display or storage
 * @param names 
 * @returns 
 */
function pickCanonical(names: string[]): string {
    let best: { norm: string, raw: string } | null = null;
    for (const raw of names) {
        const norm = normalizeName(raw);
        if (!best || norm < best.norm) best = { norm, raw };
    }
    return best ? best.raw : names[0];
}

/**
 * Merge in extra aliases from externalBrandsMapping
 * @param canonical 
 * @param aliases gets changed in place
 */
function mergeExternalAliases(canonical: string, aliases: Set<string>) {
    // If any member appears as a key in external mapping, merge its list
    const maybeKeys = [canonical, ...aliases]
    for (const k of maybeKeys) {
        const list = externalBrandsMapping[k]
        if (Array.isArray(list)) {
            for (const a of list) {
                if (a && a.trim()) aliases.add(a)
            }
        }
    }
}

export function getAliasToCanonical(): { [normAlias: string]: string } {
    const m = (getBrandsMapping as any).__aliasToCanonical;
    return m || {};
}

export async function getBrandsMapping(): Promise<BrandsMapping> {
    // build groups from brandConnections.json which is the source of truth 
    const brandConnections = connections as any[];
    const g = buildGraph(brandConnections);
    const comps = components(g);

    // for each group, choose canonical and collect aliases
    const canonicalToAliases: BrandsMapping = {};
    const aliasToCanonical: { [normalAlias: string]: string } = {};

    for (const comp of comps) {
        const aliasSet = new Set<string>(comp.filter(Boolean).map(s => s.trim()).filter(Boolean));
        const canonicalTmp = pickCanonical(Array.from(aliasSet));
        mergeExternalAliases(canonicalTmp, aliasSet);
        const canonical = pickCanonical(Array.from(aliasSet));
        const sortedAliases = Array.from(aliasSet).sort((a, b) => {
            const na = normalizeName(a), nb = normalizeName(b);
            return na < nb ? -1 : na > nb ? 1 : 0;
        });
        canonicalToAliases[canonical] = sortedAliases;
        for (const a of sortedAliases) {
            aliasToCanonical[normalizeName(a)] = canonical;
        }
    }

    ; (getBrandsMapping as any).__aliasToCanonical = aliasToCanonical

    return canonicalToAliases;
}

async function getPharmacyItems(countryCode: countryCodes, source: sources, versionKey: string, mustExist = true) {
    const finalProducts = items

    return finalProducts
}

/**
 * Checks if a given brand name exists as a separate, whole term within a larger input string.
 *
 * This function handles two scenarios for a match:
 * 1. The brand appears at the beginning or end of the input string, followed or preceded by a space.
 * 2. The brand appears anywhere else, surrounded by word boundaries (e.g., spaces, punctuation).
 *
 * It is primarily used to prevent partial word matches (e.g., preventing "sony" from matching in "sonya").
 * The check is case-insensitive.
 *
 * @param input - The larger string (e.g., a search query or a product title) to be searched.
 * @param brand - The specific brand name (term) to look for.
 * @returns {boolean} - True if the brand is found as a distinct, separate term; otherwise, false.
 */
export function checkBrandIsSeparateTerm(input: string, brand: string): boolean {
    // Escape any special characters in the brand name for use in a regular expression
    const escapedBrand = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

    // Check if the brand is at the beginning or end of the string
    const atBeginningOrEnd = new RegExp(
        `^(?:${escapedBrand}\\s|.*\\s${escapedBrand}\\s.*|.*\\s${escapedBrand})$`,
        "i"
    ).test(input)

    // Check if the brand is a separate term in the string
    const separateTerm = new RegExp(`\\b${escapedBrand}\\b`, "i").test(input)

    // The brand should be at the beginning, end, or a separate term
    return atBeginningOrEnd || separateTerm
}

/**
 * Assign a canonical brand to items using:
 *  - Level 1: alias→canonical precomputation (built via getBrandsMapping)
 *  - Level 2: normalization + rule gate (placement, stopwords, HAPPY)
 *  - Level 3: n-gram candidate extraction + deterministic tie-breakers
 *
 * Candidate ordering:
 *  1) earliest token index in the title (beginning wins)
 *  2) longest alias span (more specific phrase wins)
 *  3) lexical order of the canonical (stable fallback)
 *
 * Side effect: logs "<title> -> <canonical1,canonical2,...>" where the first
 * canonical is the chosen brand. DB write is intentionally left as a TODO.
 */
export async function assignBrandIfKnown(countryCode: countryCodes, source: sources, job?: Job) {
    const context = { scope: "assignBrandIfKnown" } as ContextType

    // Ensure mappings are built and alias→canonical cache is primed
    await getBrandsMapping()
    const aliasToCanonical =
        (getBrandsMapping as any).__aliasToCanonical || {}

    const versionKey = "assignBrandIfKnown"
    let products = await getPharmacyItems(countryCode, source, versionKey, false)

    let counter = 0
    for (let product of products) {
        counter++

        // Already exists in the mapping table, probably no need to update
        if (product.m_id) {
            continue
        }

        // --- Level 3: build and order canonical candidates ---
        const candMap = findAliasCandidates(product.title, aliasToCanonical)
        const orderedCanonicals = orderCandidates(candMap)

        const matchedBrands = orderedCanonicals
        console.log(`${product.title} -> ${matchedBrands.join(",")}`)

        const sourceId = product.source_id
        const meta = { matchedBrands }
        const brand = matchedBrands.length ? matchedBrands[0] : null

        const key = `${source}_${countryCode}_${sourceId}`
        const uuid = stringToHash(key)

        // TODO: insert/update mapping table record with:
        // { uuid, source, countryCode, sourceId, brand, meta }
    }
}


// --- Level 5: dry-run metrics reporter ---

/**
 * One product's evaluation row for the dry-run report.
 */
export interface BrandDryRunRow {
    title: string
    matches: string[]          // ordered canonicals (best→worst)
    chosen: string | null      // first of `matches` or null
    source_id?: string
}

/**
 * Aggregated metrics over a dry-run evaluation.
 */
export interface BrandDryRunReport {
    total: number
    assigned: number
    uniqueBrands: number
    byBrand: Array<{ brand: string; count: number }>  // sorted desc
    rows: BrandDryRunRow[]                            // optional: inspect if needed
}

/**
 * Evaluate all items without writing to DB:
 * - Builds alias→canonical (Level 1) if needed
 * - Applies rule gate (Level 2) and n-gram tie-breakers (Level 3)
 * - Returns coverage, unique brand count, and top brands
 */
export async function dryRunBrandAssignment(
    countryCode: countryCodes,
    source: sources
): Promise<BrandDryRunReport> {
    // ensure caches are warm
    await getBrandsMapping()
    const aliasToCanonical =
        (getBrandsMapping as any).__aliasToCanonical || {}

    const products = await getPharmacyItems(countryCode, source, "dryRun", false)
    const rows: BrandDryRunRow[] = []
    const seenBrand = new Map<string, number>()

    for (const product of products) {
        const candMap = findAliasCandidates(product.title, aliasToCanonical)
        const ordered = orderCandidates(candMap)
        const chosen = ordered.length ? ordered[0] : null

        if (chosen) {
            seenBrand.set(chosen, (seenBrand.get(chosen) || 0) + 1)
        }
        rows.push({
            title: product.title,
            matches: ordered,
            chosen,
            source_id: (product as any)?.source_id
        })
    }

    const byBrand = Array.from(seenBrand.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([brand, count]) => ({ brand, count }))

    return {
        total: products.length,
        assigned: rows.filter(r => !!r.chosen).length,
        uniqueBrands: seenBrand.size,
        byBrand,
        rows
    }
}

/**
 * Pretty-print the dry-run report to console.
 */
export function printBrandDryRunReport(r: BrandDryRunReport): void {
    console.log("=== Brand Assignment Report (dry-run) ===")
    console.log(`Items: ${r.assigned}/${r.total} assigned  |  Unique brands: ${r.uniqueBrands}`)
    const top = r.byBrand.slice(0, 10)
    if (top.length) {
        console.log("Top brands:")
        for (const { brand, count } of top) {
            console.log(`  - ${brand}: ${count}`)
        }
    } else {
        console.log("No brands assigned.")
    }
}

