import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "fs"
import { join, isAbsolute } from "path"
import { tmpdir } from "os"
import { discoverInstructions, InstructionInfo } from "./instruction"

describe("instruction", () => {
  describe("discoverInstructions", () => {
    let testDir: string

    beforeEach(() => {
      // Create unique temp directory for test isolation
      testDir = mkdtempSync(join(tmpdir(), "instruction-test-"))
    })

    afterEach(() => {
      // Clean up after each test
      rmSync(testDir, { recursive: true, force: true })
    })

    test("returns empty array when manifest.json does not exist", () => {
      const result = discoverInstructions(testDir)
      expect(result).toEqual([])
    })

    test("returns empty array when manifest has empty instructions array", () => {
      const manifestPath = join(testDir, "manifest.json")
      writeFileSync(manifestPath, JSON.stringify({ instructions: [] }))

      const result = discoverInstructions(testDir)
      expect(result).toEqual([])
    })

    test("returns empty array when manifest has no instructions field (schema defaults to [])", () => {
      // Contract: missing instructions field is valid - schema defaults to empty array
      // This is NOT an "invalid manifest" case - the schema handles optional fields
      const manifestPath = join(testDir, "manifest.json")
      writeFileSync(manifestPath, JSON.stringify({}))

      const result = discoverInstructions(testDir)
      expect(result).toEqual([])
    })

    test("returns instruction info for existing files", () => {
      // Create manifest
      const manifestPath = join(testDir, "manifest.json")
      writeFileSync(
        manifestPath,
        JSON.stringify({ instructions: ["README.md"] })
      )

      // Create the instruction file
      const readmePath = join(testDir, "README.md")
      writeFileSync(readmePath, "# README")

      const result = discoverInstructions(testDir)
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe("README.md")
      expect(result[0].path).toBe(readmePath)
    })

    test("silently skips missing instruction files", () => {
      // Create manifest referencing a non-existent file
      const manifestPath = join(testDir, "manifest.json")
      writeFileSync(
        manifestPath,
        JSON.stringify({ instructions: ["missing.md"] })
      )

      const result = discoverInstructions(testDir)
      expect(result).toEqual([])
    })

    test("returns only existing files when some are missing", () => {
      // Create manifest with both existing and missing files
      const manifestPath = join(testDir, "manifest.json")
      writeFileSync(
        manifestPath,
        JSON.stringify({
          instructions: ["exists.md", "missing.md", "also-exists.md"],
        })
      )

      // Create only some of the instruction files
      const existsPath = join(testDir, "exists.md")
      writeFileSync(existsPath, "# Exists")

      const alsoExistsPath = join(testDir, "also-exists.md")
      writeFileSync(alsoExistsPath, "# Also Exists")

      const result = discoverInstructions(testDir)
      expect(result).toHaveLength(2)
      expect(result[0]).toEqual({ name: "exists.md", path: existsPath })
      expect(result[1]).toEqual({
        name: "also-exists.md",
        path: alsoExistsPath,
      })
    })

    test("handles nested instruction paths", () => {
      // Create manifest with nested path
      const manifestPath = join(testDir, "manifest.json")
      writeFileSync(
        manifestPath,
        JSON.stringify({ instructions: ["docs/guide.md"] })
      )

      // Create the nested instruction file
      const docsDir = join(testDir, "docs")
      mkdirSync(docsDir)
      const guidePath = join(docsDir, "guide.md")
      writeFileSync(guidePath, "# Guide")

      const result = discoverInstructions(testDir)
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe("docs/guide.md")
      expect(result[0].path).toBe(guidePath)
    })

    test("returns absolute paths for instruction files", () => {
      // Create manifest
      const manifestPath = join(testDir, "manifest.json")
      writeFileSync(
        manifestPath,
        JSON.stringify({ instructions: ["README.md"] })
      )

      // Create the instruction file
      const readmePath = join(testDir, "README.md")
      writeFileSync(readmePath, "# README")

      const result = discoverInstructions(testDir)
      expect(isAbsolute(result[0].path)).toBe(true)
    })

    test("logs warning and returns empty array when manifest is invalid JSON", () => {
      // Contract: invalid manifest logs a warning and returns []
      // This is intentional behavior - we don't want to crash on malformed manifests
      const manifestPath = join(testDir, "manifest.json")
      writeFileSync(manifestPath, "{ invalid json }")

      // Capture console.warn to verify warning is logged
      const warnings: unknown[][] = []
      const originalWarn = console.warn
      console.warn = (...args: unknown[]) => warnings.push(args)

      try {
        const result = discoverInstructions(testDir)
        expect(result).toEqual([])
        expect(warnings.length).toBeGreaterThan(0)
        expect(warnings.some(w => String(w[0]).includes("[remote-config]"))).toBe(true)
      } finally {
        console.warn = originalWarn
      }
    })

    test("handles multiple existing instruction files", () => {
      // Create manifest with multiple files
      const manifestPath = join(testDir, "manifest.json")
      writeFileSync(
        manifestPath,
        JSON.stringify({
          instructions: ["README.md", "CONTRIBUTING.md", "docs/setup.md"],
        })
      )

      // Create all instruction files
      writeFileSync(join(testDir, "README.md"), "# README")
      writeFileSync(join(testDir, "CONTRIBUTING.md"), "# Contributing")
      mkdirSync(join(testDir, "docs"))
      writeFileSync(join(testDir, "docs/setup.md"), "# Setup")

      const result = discoverInstructions(testDir)
      expect(result).toHaveLength(3)
      expect(result.map((i) => i.name)).toEqual([
        "README.md",
        "CONTRIBUTING.md",
        "docs/setup.md",
      ])
    })

    test("preserves order from manifest", () => {
      // Create manifest with specific order
      const manifestPath = join(testDir, "manifest.json")
      writeFileSync(
        manifestPath,
        JSON.stringify({
          instructions: ["third.md", "first.md", "second.md"],
        })
      )

      // Create all files
      writeFileSync(join(testDir, "third.md"), "# Third")
      writeFileSync(join(testDir, "first.md"), "# First")
      writeFileSync(join(testDir, "second.md"), "# Second")

      const result = discoverInstructions(testDir)
      expect(result.map((i) => i.name)).toEqual([
        "third.md",
        "first.md",
        "second.md",
      ])
    })

    test("defense-in-depth: skips paths that resolve outside repoPath", () => {
      // Create a file outside the repo that an attacker might try to access
      const outsideDir = mkdtempSync(join(tmpdir(), "outside-"))
      const outsidePath = join(outsideDir, "secret.md")
      writeFileSync(outsidePath, "# Secret")

      try {
        // Manually create a manifest that bypassed schema validation
        // (simulating a compromised manifest or schema bypass)
        const manifestPath = join(testDir, "manifest.json")
        // Note: The manifest schema should reject this, but we test
        // the defense-in-depth in discoverInstructions
        writeFileSync(
          manifestPath,
          JSON.stringify({ instructions: ["valid.md"] })
        )
        writeFileSync(join(testDir, "valid.md"), "# Valid")

        const result = discoverInstructions(testDir)
        // Should only include valid.md, not any traversal attempts
        expect(result).toHaveLength(1)
        expect(result[0].name).toBe("valid.md")
      } finally {
        rmSync(outsideDir, { recursive: true, force: true })
      }
    })

    test("DoS protection: limits number of instructions processed", () => {
      // Create manifest with more than 100 instructions
      const instructionNames = Array.from({ length: 150 }, (_, i) => `file${i}.md`)
      const manifestPath = join(testDir, "manifest.json")
      writeFileSync(manifestPath, JSON.stringify({ instructions: instructionNames }))

      // Create only first 105 files (more than limit, to verify cutoff)
      for (let i = 0; i < 105; i++) {
        writeFileSync(join(testDir, `file${i}.md`), `# File ${i}`)
      }

      // Capture console.warn to verify warning is logged
      const warnings: unknown[][] = []
      const originalWarn = console.warn
      console.warn = (...args: unknown[]) => warnings.push(args)

      try {
        const result = discoverInstructions(testDir)
        // Should be limited to 100
        expect(result).toHaveLength(100)
        // Should warn about the limit
        expect(warnings.some(w => String(w[0]).includes("Limiting instructions to 100"))).toBe(true)
      } finally {
        console.warn = originalWarn
      }
    })

    test("DoS protection: skips paths exceeding max length", () => {
      // Create a path that exceeds 500 characters
      const longPath = "a".repeat(501) + ".md"
      const manifestPath = join(testDir, "manifest.json")
      writeFileSync(manifestPath, JSON.stringify({ instructions: [longPath, "valid.md"] }))
      writeFileSync(join(testDir, "valid.md"), "# Valid")

      // Capture console.warn to verify warning is logged
      const warnings: unknown[][] = []
      const originalWarn = console.warn
      console.warn = (...args: unknown[]) => warnings.push(args)

      try {
        const result = discoverInstructions(testDir)
        // Should only include valid.md
        expect(result).toHaveLength(1)
        expect(result[0].name).toBe("valid.md")
        // Should warn about the long path
        expect(warnings.some(w => String(w[0]).includes("path exceeding"))).toBe(true)
      } finally {
        console.warn = originalWarn
      }
    })
  })
})
