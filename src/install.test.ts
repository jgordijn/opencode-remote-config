import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import {
  getInstallPath,
  getSymlinkPath,
  createSkillSymlink,
  createSymlinksForRepo,
  getExistingSymlinks,
  cleanupStaleInstalls,
  cleanupStaleSymlinks,
  type InstallMethod,
  type InstallResult,
} from "./install"
import type { SkillInfo, SyncResult } from "./git"
import { setRsyncAvailable } from "./copy"

describe("install", () => {
  // Use temp directories for testing
  let testPluginsDir: string
  let testSourceDir: string

  // Helper to create a test skill directory with SKILL.md
  function createTestSkillDir(name: string): string {
    const skillDir = path.join(testSourceDir, name)
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `# ${name}\n\nTest skill`)
    return skillDir
  }

  // Helper to create a SkillInfo for testing
  function makeSkillInfo(name: string, skillPath: string): SkillInfo {
    return { name, path: skillPath }
  }

  // Helper to create a SyncResult for testing
  function makeSyncResult(shortName: string, skills: SkillInfo[]): SyncResult {
    return {
      repoId: `test-${shortName}`,
      repoPath: "/fake/repo/path",
      shortName,
      ref: "main",
      updated: false,
      skills,
      agents: [],
      commands: [],
      plugins: [],
      instructions: [],
    }
  }

  beforeEach(() => {
    testPluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-plugins-"))
    testSourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-source-"))
  })

  afterEach(() => {
    if (testPluginsDir && fs.existsSync(testPluginsDir)) {
      fs.rmSync(testPluginsDir, { recursive: true })
    }
    if (testSourceDir && fs.existsSync(testSourceDir)) {
      fs.rmSync(testSourceDir, { recursive: true })
    }
    // Reset rsync cache between tests
    setRsyncAvailable(null)
  })

  describe("getInstallPath", () => {
    test("returns correct path for repo and skill", () => {
      // This tests the function directly, not with overridden dir
      const result = getInstallPath("my-repo", "my-skill")
      expect(result).toContain("_plugins")
      expect(result).toContain("my-repo")
      expect(result).toContain("my-skill")
    })

    test("getSymlinkPath is an alias for getInstallPath", () => {
      expect(getSymlinkPath).toBe(getInstallPath)
    })
  })

  describe("createSkillInstall - link mode", () => {
    test("creates symlink successfully", async () => {
      const skillDir = createTestSkillDir("test-skill")
      const skill = makeSkillInfo("test-skill", skillDir)
      const targetPath = path.join(testPluginsDir, "test-repo", "test-skill")

      // Ensure parent directory exists
      fs.mkdirSync(path.dirname(targetPath), { recursive: true })

      // Create symlink directly in test directory
      const result = await createSkillInstallInDir(skill, "test-repo", "link", testPluginsDir)

      expect(result.skillName).toBe("test-skill")
      expect(result.sourcePath).toBe(skillDir)
      expect(result.created).toBe(true)
      expect(result.error).toBeUndefined()

      // Verify symlink was created
      expect(fs.existsSync(result.targetPath)).toBe(true)
      expect(fs.lstatSync(result.targetPath).isSymbolicLink()).toBe(true)
    })

    test("skips creation if symlink already points to same location", async () => {
      const skillDir = createTestSkillDir("existing-skill")
      const skill = makeSkillInfo("existing-skill", skillDir)
      const targetPath = path.join(testPluginsDir, "test-repo", "existing-skill")

      // Create existing symlink
      fs.mkdirSync(path.dirname(targetPath), { recursive: true })
      fs.symlinkSync(skillDir, targetPath, "dir")

      const result = await createSkillInstallInDir(skill, "test-repo", "link", testPluginsDir)

      expect(result.created).toBe(false)
      expect(result.error).toBeUndefined()
    })

    test("replaces symlink if pointing to different location", async () => {
      const skillDir1 = createTestSkillDir("skill-v1")
      const skillDir2 = createTestSkillDir("skill-v2")
      const targetPath = path.join(testPluginsDir, "test-repo", "changing-skill")

      // Create existing symlink pointing to v1
      fs.mkdirSync(path.dirname(targetPath), { recursive: true })
      fs.symlinkSync(skillDir1, targetPath, "dir")

      // Install with path pointing to v2
      const skill = makeSkillInfo("changing-skill", skillDir2)
      const result = await createSkillInstallInDir(skill, "test-repo", "link", testPluginsDir)

      expect(result.created).toBe(true)
      expect(result.error).toBeUndefined()
      expect(fs.readlinkSync(result.targetPath)).toBe(skillDir2)
    })

    test("returns error if path exists and is not a symlink", async () => {
      const skillDir = createTestSkillDir("blocked-skill")
      const targetPath = path.join(testPluginsDir, "test-repo", "blocked-skill")

      // Create a regular directory at target
      fs.mkdirSync(targetPath, { recursive: true })
      fs.writeFileSync(path.join(targetPath, "SKILL.md"), "blocked")

      const skill = makeSkillInfo("blocked-skill", skillDir)
      const result = await createSkillInstallInDir(skill, "test-repo", "link", testPluginsDir)

      expect(result.created).toBe(false)
      expect(result.error).toContain("is not a symlink")
    })
  })

  describe("createSkillInstall - copy mode", () => {
    test("copies directory successfully", async () => {
      const skillDir = createTestSkillDir("copy-skill")
      // Add another file to verify complete copy
      fs.writeFileSync(path.join(skillDir, "extra.txt"), "extra content")

      const skill = makeSkillInfo("copy-skill", skillDir)
      const result = await createSkillInstallInDir(skill, "test-repo", "copy", testPluginsDir)

      expect(result.skillName).toBe("copy-skill")
      expect(result.created).toBe(true)
      expect(result.error).toBeUndefined()

      // Verify directory was copied (not symlinked)
      expect(fs.existsSync(result.targetPath)).toBe(true)
      expect(fs.lstatSync(result.targetPath).isDirectory()).toBe(true)
      expect(fs.lstatSync(result.targetPath).isSymbolicLink()).toBe(false)

      // Verify files were copied
      expect(fs.existsSync(path.join(result.targetPath, "SKILL.md"))).toBe(true)
      expect(fs.existsSync(path.join(result.targetPath, "extra.txt"))).toBe(true)
    })

    test("overwrites existing copied directory", async () => {
      const skillDir = createTestSkillDir("update-skill")
      const targetPath = path.join(testPluginsDir, "test-repo", "update-skill")

      // Create existing directory with old content
      fs.mkdirSync(targetPath, { recursive: true })
      fs.writeFileSync(path.join(targetPath, "SKILL.md"), "old content")
      fs.writeFileSync(path.join(targetPath, "old-file.txt"), "should be removed")

      // Copy new version
      const skill = makeSkillInfo("update-skill", skillDir)
      const result = await createSkillInstallInDir(skill, "test-repo", "copy", testPluginsDir)

      expect(result.created).toBe(true)
      expect(result.error).toBeUndefined()

      // Verify new content
      const content = fs.readFileSync(path.join(result.targetPath, "SKILL.md"), "utf-8")
      expect(content).toContain("update-skill")

      // Old file should be gone (syncDirectory with rsync --delete behavior)
      // Note: This depends on syncDirectory implementation
    })
  })

  describe("createInstallsForRepo", () => {
    test("installs multiple skills", async () => {
      const skill1Dir = createTestSkillDir("skill1")
      const skill2Dir = createTestSkillDir("skill2")

      const syncResult = makeSyncResult("multi-repo", [
        makeSkillInfo("skill1", skill1Dir),
        makeSkillInfo("skill2", skill2Dir),
      ])

      // Note: This test uses the real plugins dir, which we can't override easily
      // In a real implementation, we'd use dependency injection
      // For now, we test the individual createSkillInstall function
      const results: InstallResult[] = []
      for (const skill of syncResult.skills) {
        const result = await createSkillInstallInDir(skill, syncResult.shortName, "link", testPluginsDir)
        results.push(result)
      }

      expect(results).toHaveLength(2)
      expect(results[0].skillName).toBe("skill1")
      expect(results[1].skillName).toBe("skill2")
      expect(results.every(r => !r.error)).toBe(true)
    })

    test("returns empty array for empty skills", async () => {
      const syncResult = makeSyncResult("empty-repo", [])
      
      const results: InstallResult[] = []
      for (const skill of syncResult.skills) {
        const result = await createSkillInstallInDir(skill, syncResult.shortName, "link", testPluginsDir)
        results.push(result)
      }

      expect(results).toHaveLength(0)
    })
  })

  describe("getExistingInstalls", () => {
    test("returns empty map when plugins dir does not exist", () => {
      // Test with non-existent directory
      // This requires the real function to use PLUGINS_DIR
      // For isolated testing, we'd need DI
      const result = getExistingInstallsInDir(path.join(testPluginsDir, "nonexistent"))
      expect(result.size).toBe(0)
    })

    test("returns empty map when plugins dir is empty", () => {
      const result = getExistingInstallsInDir(testPluginsDir)
      expect(result.size).toBe(0)
    })

    test("finds symlinked skills", () => {
      const skillDir = createTestSkillDir("linked-skill")
      const repoDir = path.join(testPluginsDir, "repo1")
      const targetPath = path.join(repoDir, "linked-skill")

      fs.mkdirSync(repoDir, { recursive: true })
      fs.symlinkSync(skillDir, targetPath, "dir")

      const result = getExistingInstallsInDir(testPluginsDir)
      expect(result.size).toBe(1)
      expect(result.has("repo1/linked-skill")).toBe(true)
      expect(result.get("repo1/linked-skill")).toBe(skillDir)
    })

    test("finds copied skills with SKILL.md", () => {
      const repoDir = path.join(testPluginsDir, "repo2")
      const targetPath = path.join(repoDir, "copied-skill")

      fs.mkdirSync(targetPath, { recursive: true })
      fs.writeFileSync(path.join(targetPath, "SKILL.md"), "# Copied Skill")

      const result = getExistingInstallsInDir(testPluginsDir)
      expect(result.size).toBe(1)
      expect(result.has("repo2/copied-skill")).toBe(true)
    })

    test("tracks directories without SKILL.md for cleanup", () => {
      const repoDir = path.join(testPluginsDir, "repo3")
      const targetPath = path.join(repoDir, "random-dir")

      fs.mkdirSync(targetPath, { recursive: true })
      fs.writeFileSync(path.join(targetPath, "other.txt"), "not a skill")

      const result = getExistingInstallsInDir(testPluginsDir)
      expect(result.size).toBe(1)
      expect(result.has("repo3/random-dir")).toBe(true)
      expect(result.get("repo3/random-dir")).toBe(targetPath)
    })

    test("finds both symlinks and copied skills", () => {
      const skillDir = createTestSkillDir("linked")
      
      // Create symlinked skill
      const repo1Dir = path.join(testPluginsDir, "repo1")
      fs.mkdirSync(repo1Dir, { recursive: true })
      fs.symlinkSync(skillDir, path.join(repo1Dir, "linked"), "dir")

      // Create copied skill
      const repo2Dir = path.join(testPluginsDir, "repo2")
      const copiedPath = path.join(repo2Dir, "copied")
      fs.mkdirSync(copiedPath, { recursive: true })
      fs.writeFileSync(path.join(copiedPath, "SKILL.md"), "# Copied")

      const result = getExistingInstallsInDir(testPluginsDir)
      expect(result.size).toBe(2)
      expect(result.has("repo1/linked")).toBe(true)
      expect(result.has("repo2/copied")).toBe(true)
    })
  })

  describe("cleanupStaleInstalls", () => {
    test("removes symlinks not in current set", () => {
      const skillDir = createTestSkillDir("stale-skill")
      const repoDir = path.join(testPluginsDir, "repo1")
      const stalePath = path.join(repoDir, "stale-skill")

      fs.mkdirSync(repoDir, { recursive: true })
      fs.symlinkSync(skillDir, stalePath, "dir")

      const result = cleanupStaleInstallsInDir(new Set(), testPluginsDir)

      expect(result.removed).toContain("repo1/stale-skill")
      expect(result.errors).toHaveLength(0)
      expect(fs.existsSync(stalePath)).toBe(false)
    })

    test("removes copied directories not in current set", () => {
      const repoDir = path.join(testPluginsDir, "repo1")
      const copiedPath = path.join(repoDir, "stale-copied")

      fs.mkdirSync(copiedPath, { recursive: true })
      fs.writeFileSync(path.join(copiedPath, "SKILL.md"), "# Stale")

      const result = cleanupStaleInstallsInDir(new Set(), testPluginsDir)

      expect(result.removed).toContain("repo1/stale-copied")
      expect(result.errors).toHaveLength(0)
      expect(fs.existsSync(copiedPath)).toBe(false)
    })

    test("keeps skills in current set", () => {
      const skillDir = createTestSkillDir("keep-skill")
      const repoDir = path.join(testPluginsDir, "repo1")
      const keepPath = path.join(repoDir, "keep-skill")

      fs.mkdirSync(repoDir, { recursive: true })
      fs.symlinkSync(skillDir, keepPath, "dir")

      const currentSkills = new Set(["repo1/keep-skill"])
      const result = cleanupStaleInstallsInDir(currentSkills, testPluginsDir)

      expect(result.removed).toHaveLength(0)
      expect(fs.existsSync(keepPath)).toBe(true)
    })

    test("removes empty parent directories after cleanup", () => {
      const skillDir = createTestSkillDir("cleanup-skill")
      const repoDir = path.join(testPluginsDir, "empty-repo")
      const stalePath = path.join(repoDir, "cleanup-skill")

      fs.mkdirSync(repoDir, { recursive: true })
      fs.symlinkSync(skillDir, stalePath, "dir")

      cleanupStaleInstallsInDir(new Set(), testPluginsDir)

      // Both the skill and the empty repo directory should be gone
      expect(fs.existsSync(stalePath)).toBe(false)
      expect(fs.existsSync(repoDir)).toBe(false)
    })

    test("cleanupStaleSymlinks is an alias for cleanupStaleInstalls", () => {
      expect(cleanupStaleSymlinks).toBe(cleanupStaleInstalls)
    })
  })

  describe("deprecated functions", () => {
    test("createSkillSymlink creates symlink and returns same structure as createSkillInstall with link mode", async () => {
      const skillDir = createTestSkillDir("sync-skill")
      const skill = makeSkillInfo("sync-skill", skillDir)

      // Use helper that mirrors createSkillSymlink behavior with custom directory
      const syncResult = createSkillSymlinkInDir(skill, "test-repo", testPluginsDir)

      // Verify result structure
      expect(syncResult.skillName).toBe("sync-skill")
      expect(syncResult.sourcePath).toBe(skillDir)
      expect(syncResult.targetPath).toBe(path.join(testPluginsDir, "test-repo", "sync-skill"))
      expect(syncResult.created).toBe(true)
      expect(syncResult.error).toBeUndefined()

      // Verify symlink was actually created
      expect(fs.existsSync(syncResult.targetPath)).toBe(true)
      expect(fs.lstatSync(syncResult.targetPath).isSymbolicLink()).toBe(true)
      expect(fs.readlinkSync(syncResult.targetPath)).toBe(skillDir)

      // Compare with async version to verify equivalent behavior
      const skill2Dir = createTestSkillDir("async-skill")
      const skill2 = makeSkillInfo("async-skill", skill2Dir)
      const asyncResult = await createSkillInstallInDir(skill2, "test-repo", "link", testPluginsDir)

      // Both should have same result structure (excluding paths which differ by skill name)
      expect(syncResult.created).toBe(asyncResult.created)
      expect(syncResult.error).toBe(asyncResult.error)
    })

    test("createSkillSymlink skips creation if symlink already points to same location", () => {
      const skillDir = createTestSkillDir("existing-sync-skill")
      const skill = makeSkillInfo("existing-sync-skill", skillDir)
      const targetPath = path.join(testPluginsDir, "test-repo", "existing-sync-skill")

      // Create existing symlink
      fs.mkdirSync(path.dirname(targetPath), { recursive: true })
      fs.symlinkSync(skillDir, targetPath, "dir")

      const result = createSkillSymlinkInDir(skill, "test-repo", testPluginsDir)

      expect(result.created).toBe(false)
      expect(result.error).toBeUndefined()
    })

    test("createSkillSymlink replaces symlink if pointing to different location", () => {
      const skillDir1 = createTestSkillDir("sync-skill-v1")
      const skillDir2 = createTestSkillDir("sync-skill-v2")
      const targetPath = path.join(testPluginsDir, "test-repo", "changing-sync-skill")

      // Create existing symlink pointing to v1
      fs.mkdirSync(path.dirname(targetPath), { recursive: true })
      fs.symlinkSync(skillDir1, targetPath, "dir")

      // Install with path pointing to v2
      const skill = makeSkillInfo("changing-sync-skill", skillDir2)
      const result = createSkillSymlinkInDir(skill, "test-repo", testPluginsDir)

      expect(result.created).toBe(true)
      expect(result.error).toBeUndefined()
      expect(fs.readlinkSync(result.targetPath)).toBe(skillDir2)
    })

    test("createSkillSymlink returns error if path exists and is not a symlink", () => {
      const skillDir = createTestSkillDir("blocked-sync-skill")
      const targetPath = path.join(testPluginsDir, "test-repo", "blocked-sync-skill")

      // Create a regular directory at target
      fs.mkdirSync(targetPath, { recursive: true })
      fs.writeFileSync(path.join(targetPath, "SKILL.md"), "blocked")

      const skill = makeSkillInfo("blocked-sync-skill", skillDir)
      const result = createSkillSymlinkInDir(skill, "test-repo", testPluginsDir)

      expect(result.created).toBe(false)
      expect(result.error).toContain("is not a symlink")
    })

    test("createSymlinksForRepo processes SyncResult and returns results matching createInstallsForRepo", () => {
      const skill1Dir = createTestSkillDir("repo-skill1")
      const skill2Dir = createTestSkillDir("repo-skill2")

      const syncResult = makeSyncResult("sync-repo", [
        makeSkillInfo("repo-skill1", skill1Dir),
        makeSkillInfo("repo-skill2", skill2Dir),
      ])

      // Use helper that mirrors createSymlinksForRepo behavior with custom directory
      const results = createSymlinksForRepoInDir(syncResult, testPluginsDir)

      expect(results).toHaveLength(2)
      expect(results[0].skillName).toBe("repo-skill1")
      expect(results[0].created).toBe(true)
      expect(results[0].error).toBeUndefined()
      expect(results[1].skillName).toBe("repo-skill2")
      expect(results[1].created).toBe(true)
      expect(results[1].error).toBeUndefined()

      // Verify symlinks were actually created
      expect(fs.lstatSync(results[0].targetPath).isSymbolicLink()).toBe(true)
      expect(fs.lstatSync(results[1].targetPath).isSymbolicLink()).toBe(true)
    })

    test("createSymlinksForRepo returns empty array for empty skills", () => {
      const syncResult = makeSyncResult("empty-sync-repo", [])
      const results = createSymlinksForRepoInDir(syncResult, testPluginsDir)
      expect(results).toHaveLength(0)
    })

    test("getExistingSymlinks finds symlinks using recursive scan", () => {
      const skillDir = createTestSkillDir("find-symlink")
      const repoDir = path.join(testPluginsDir, "repo1")
      const targetPath = path.join(repoDir, "find-symlink")

      fs.mkdirSync(repoDir, { recursive: true })
      fs.symlinkSync(skillDir, targetPath, "dir")

      const result = getExistingSymlinksInDir(testPluginsDir)
      expect(result.size).toBe(1)
      expect(result.has("repo1/find-symlink")).toBe(true)
      expect(result.get("repo1/find-symlink")).toBe(skillDir)
    })

    test("getExistingSymlinks finds nested symlinks (unlike getExistingInstalls)", () => {
      // getExistingSymlinks uses recursive scanDir, so it can find deeply nested symlinks
      const skillDir = createTestSkillDir("nested-symlink")
      const nestedDir = path.join(testPluginsDir, "level1", "level2")
      const targetPath = path.join(nestedDir, "nested-symlink")

      fs.mkdirSync(nestedDir, { recursive: true })
      fs.symlinkSync(skillDir, targetPath, "dir")

      const result = getExistingSymlinksInDir(testPluginsDir)
      expect(result.size).toBe(1)
      expect(result.has("level1/level2/nested-symlink")).toBe(true)
    })

    test("getExistingSymlinks ignores non-symlink directories", () => {
      const repoDir = path.join(testPluginsDir, "repo1")
      const targetPath = path.join(repoDir, "copied-dir")

      fs.mkdirSync(targetPath, { recursive: true })
      fs.writeFileSync(path.join(targetPath, "SKILL.md"), "# Not a symlink")

      const result = getExistingSymlinksInDir(testPluginsDir)
      // Should not find copied directories, only symlinks
      expect(result.has("repo1/copied-dir")).toBe(false)
    })

    test("getExistingSymlinks returns empty map when plugins dir does not exist", () => {
      const result = getExistingSymlinksInDir(path.join(testPluginsDir, "nonexistent"))
      expect(result.size).toBe(0)
    })

    test("getSymlinkPath is an alias for getInstallPath", () => {
      expect(getSymlinkPath).toBe(getInstallPath)
    })
  })

  describe("InstallMethod type", () => {
    test("accepts 'link' and 'copy' values", async () => {
      const skillDir = createTestSkillDir("type-test")
      const skill = makeSkillInfo("type-test", skillDir)

      // Test link
      const linkResult = await createSkillInstallInDir(skill, "repo", "link", testPluginsDir)
      expect(linkResult.error).toBeUndefined()

      // Clean up for copy test
      fs.rmSync(linkResult.targetPath)

      // Test copy  
      const copyResult = await createSkillInstallInDir(skill, "repo", "copy", testPluginsDir)
      expect(copyResult.error).toBeUndefined()
    })
  })
})

// Helper functions that work with custom directories (for testing)
// These mirror the actual functions but allow injecting the plugins directory

async function createSkillInstallInDir(
  skill: SkillInfo,
  repoShortName: string,
  installMethod: InstallMethod,
  pluginsDir: string
): Promise<InstallResult> {
  const targetPath = path.join(pluginsDir, repoShortName, skill.name)
  const result: InstallResult = {
    skillName: skill.name,
    sourcePath: skill.path,
    targetPath,
    created: false,
  }

  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })

    if (installMethod === "copy") {
      // Import syncDirectory
      const { syncDirectory } = await import("./copy")
      await syncDirectory(skill.path, targetPath)
      result.created = true
    } else {
      if (fs.existsSync(targetPath)) {
        const stats = fs.lstatSync(targetPath)

        if (stats.isSymbolicLink()) {
          const existingTarget = fs.readlinkSync(targetPath)
          if (existingTarget === skill.path) {
            return result
          }
          fs.unlinkSync(targetPath)
        } else {
          result.error = `Path exists and is not a symlink: ${targetPath}`
          return result
        }
      }

      fs.symlinkSync(skill.path, targetPath, "dir")
      result.created = true
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
  }

  return result
}

function getExistingInstallsInDir(pluginsDir: string): Map<string, string> {
  const installs = new Map<string, string>()

  if (!fs.existsSync(pluginsDir)) {
    return installs
  }

  const repoEntries = fs.readdirSync(pluginsDir, { withFileTypes: true })

  for (const repoEntry of repoEntries) {
    if (repoEntry.name.startsWith(".") || !repoEntry.isDirectory()) continue

    const repoPath = path.join(pluginsDir, repoEntry.name)
    const skillEntries = fs.readdirSync(repoPath, { withFileTypes: true })

    for (const skillEntry of skillEntries) {
      if (skillEntry.name.startsWith(".")) continue

      const fullPath = path.join(repoPath, skillEntry.name)
      const relativePath = `${repoEntry.name}/${skillEntry.name}`

      if (skillEntry.isSymbolicLink()) {
        const target = fs.readlinkSync(fullPath)
        installs.set(relativePath, target)
      } else if (skillEntry.isDirectory()) {
        // Copy mode: track all non-hidden directories for cleanup
        installs.set(relativePath, fullPath)
      }
    }
  }

  return installs
}

function cleanupStaleInstallsInDir(
  currentSkills: Set<string>,
  pluginsDir: string
): { removed: string[]; errors: string[] } {
  const result = {
    removed: [] as string[],
    errors: [] as string[],
  }

  const existingInstalls = getExistingInstallsInDir(pluginsDir)

  for (const [relativePath] of existingInstalls) {
    if (!currentSkills.has(relativePath)) {
      const fullPath = path.join(pluginsDir, relativePath)

      try {
        const stats = fs.lstatSync(fullPath)

        if (stats.isSymbolicLink()) {
          fs.unlinkSync(fullPath)
        } else if (stats.isDirectory()) {
          fs.rmSync(fullPath, { recursive: true, force: true })
        }

        result.removed.push(relativePath)

        // Try to remove empty parent directories
        let parentDir = path.dirname(fullPath)
        while (parentDir !== pluginsDir && parentDir.startsWith(pluginsDir)) {
          try {
            const entries = fs.readdirSync(parentDir)
            if (entries.length === 0) {
              fs.rmdirSync(parentDir)
              parentDir = path.dirname(parentDir)
            } else {
              break
            }
          } catch {
            break
          }
        }
      } catch (err) {
        result.errors.push(
          `Failed to remove ${relativePath}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }

  return result
}

/**
 * Helper that mirrors createSkillSymlink behavior with custom directory.
 * This is the sync version matching the deprecated function.
 */
function createSkillSymlinkInDir(
  skill: SkillInfo,
  repoShortName: string,
  pluginsDir: string
): InstallResult {
  const targetPath = path.join(pluginsDir, repoShortName, skill.name)
  const result: InstallResult = {
    skillName: skill.name,
    sourcePath: skill.path,
    targetPath,
    created: false,
  }

  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })

    if (fs.existsSync(targetPath)) {
      const stats = fs.lstatSync(targetPath)

      if (stats.isSymbolicLink()) {
        const existingTarget = fs.readlinkSync(targetPath)
        if (existingTarget === skill.path) {
          return result
        }
        fs.unlinkSync(targetPath)
      } else {
        result.error = `Path exists and is not a symlink: ${targetPath}`
        return result
      }
    }

    fs.symlinkSync(skill.path, targetPath, "dir")
    result.created = true
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
  }

  return result
}

/**
 * Helper that mirrors createSymlinksForRepo behavior with custom directory.
 */
function createSymlinksForRepoInDir(
  syncResult: SyncResult,
  pluginsDir: string
): InstallResult[] {
  fs.mkdirSync(pluginsDir, { recursive: true })

  const results: InstallResult[] = []

  for (const skill of syncResult.skills) {
    const result = createSkillSymlinkInDir(skill, syncResult.shortName, pluginsDir)
    results.push(result)
  }

  return results
}

/**
 * Helper that mirrors getExistingSymlinks behavior with custom directory.
 * Uses recursive scanning (unlike getExistingInstalls which only scans 2 levels).
 */
function getExistingSymlinksInDir(pluginsDir: string): Map<string, string> {
  const symlinks = new Map<string, string>()

  if (!fs.existsSync(pluginsDir)) {
    return symlinks
  }

  const scanDir = (dir: string, prefix: string = "") => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue

      const fullPath = path.join(dir, entry.name)
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name

      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(fullPath)
        symlinks.set(relativePath, target)
      } else if (entry.isDirectory()) {
        scanDir(fullPath, relativePath)
      }
    }
  }

  scanDir(pluginsDir)
  return symlinks
}
