import { execSync } from "child_process"
import fs from "fs"

const results = []

function run(name, cmd) {
  console.log(`Running ${name}...`)
  try {
    const out = execSync(cmd, { encoding: "utf8", stdio: "pipe", timeout: 180000 })
    results.push({ name, success: true, output: out.slice(0, 1000) })
    console.log(`  PASS: ${name}`)
  } catch (e) {
    const err = (e.stdout || "") + "\n" + (e.stderr || "") + "\n" + (e.message || "")
    results.push({ name, success: false, output: err.slice(0, 1000) })
    console.error(`  FAIL: ${name}`)
  }
}

run("Build", "npx next build")
run("Outlook Smoke", "node scripts/smoke-outlook.mjs")
run("Main Smoke", "node scripts/smoke.mjs")

fs.writeFileSync("verify-summary.json", JSON.stringify(results, null, 2))
console.log("\nVerification complete. Summary written to verify-summary.json")
