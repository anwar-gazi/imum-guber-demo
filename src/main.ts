// import { sources } from "src"

import { assignBrandIfKnown } from "./common/brands"
import { countryCodes } from "./config/enums"
import { sources } from "./sites/sources"

export async function runTest() {
    await assignBrandIfKnown(countryCodes.lt, sources.APO)
}

runTest()


// --- Level 5: CLI switches for reporting ---
import { dryRunBrandAssignment, printBrandDryRunReport } from "./common/brands"

async function maybeRunReport() {
  const argv = process.argv.slice(2)
  const wantReport = argv.includes("--report") || argv.includes("--report-json")
  if (!wantReport) return

  const json = argv.includes("--report-json")

  const country = countryCodes.lt
  const source = sources.APO

  const report = await dryRunBrandAssignment(country, source)

  if (json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2))
  } else {
    printBrandDryRunReport(report)
  }
  process.exit(0)
}

// Call the reporter if requested; otherwise continue with default run
maybeRunReport().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e)
  process.exit(1)
})
