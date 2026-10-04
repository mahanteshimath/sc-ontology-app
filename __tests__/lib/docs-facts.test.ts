/**
 * Docs must not contradict the measured facts.
 *
 * The evaluation found the README, deck and scripts quoting three different accuracy figures and two
 * different metric counts. docs/FACTS.json is now the single source; this test fails if a document
 * reintroduces a known-stale figure or drops the current one.
 */

import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(__dirname, "../..")
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8")
const facts = JSON.parse(read("docs/FACTS.json"))

const DOCS = ["README.md", "docs/SUBMISSION_DECK.md", "docs/VIDEO_SCRIPT.md", "docs/JUDGE_QA.md", "public/deck/index.html"]

describe("documentation agrees with docs/FACTS.json", () => {
  it("quotes the latest full eval run, not a superseded one as current", () => {
    const pct = facts.eval.latestFullRun.accuracyPct.toFixed(1)
    for (const d of ["README.md", "docs/SUBMISSION_DECK.md", "public/deck/index.html"]) {
      expect(read(d), d).toContain(`${pct}`)
    }
  })

  it("never states a stale metric count", () => {
    for (const d of DOCS) {
      const text = read(d)
      expect(text, d).not.toMatch(/\bfourteen\b[^.\n]{0,20}metrics/i)
      expect(text, d).not.toMatch(/\b14 (governed )?metrics\b/i)
    }
    expect(read("README.md")).toContain(`${facts.governedMetrics} governed metrics`)
  })

  it("quotes the current unit test count", () => {
    expect(read("README.md")).toContain(`${facts.unitTests} / ${facts.unitTests}`)
    expect(read("public/deck/index.html")).toContain(`${facts.unitTests} of ${facts.unitTests} tests`)
  })

  it("does not recommend ACCOUNTADMIN as the runtime role", () => {
    expect(read("README.md")).not.toMatch(/\| `SNOWFLAKE_ROLE` \| no \| `ACCOUNTADMIN`/)
  })
})
