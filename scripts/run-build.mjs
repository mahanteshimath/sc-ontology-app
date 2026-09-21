import { execSync } from "child_process"
import fs from "fs"

try {
  const out = execSync("npx next build", { encoding: "utf8", stdio: "pipe" })
  fs.writeFileSync("build-result.log", out)
  console.log("BUILD SUCCESS")
} catch (e) {
  fs.writeFileSync("build-result.log", (e.stdout || "") + "\n" + (e.stderr || ""))
  console.error("BUILD ERROR", e.message)
  process.exit(1)
}
