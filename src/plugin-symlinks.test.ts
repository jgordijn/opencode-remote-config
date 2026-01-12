import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import {
  getPluginSymlinkName,
  createPluginSymlink,
  createPluginSymlinks,
  getRemotePluginSymlinks,
  cleanupStalePluginSymlinks,
  isRemotePluginSymlink,
  ensurePluginDir,
  getPluginSymlinkPath,
} from "./plugin-symlinks"
import type { PluginInfo } from "./plugin-info"

describe("plugin-symlinks", () => {
  // Use a temp directory for all filesystem tests
  let testPluginDir: string
  let testSourceDir: string

  beforeEach(() => {
    testPluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-plugin-dir-"))
    testSourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-source-dir-"))
  })

  afterEach(() => {
    if (testPluginDir && fs.existsSync(testPluginDir)) {
      fs.rmSync(testPluginDir, { recursive: true })
    }
    if (testSourceDir && fs.existsSync(testSourceDir)) {
      fs.rmSync(testSourceDir, { recursive: true })
    }
  })

  describe("getPluginSymlinkName", () => {
    test("generates correct name for simple plugin", () => {
      const plugin: PluginInfo = {
        name: "notify",
        path: "/some/path/notify.ts",
        repoShortName: "my-hooks",
        extension: ".ts",
      }
      
      expect(getPluginSymlinkName(plugin)).toBe("_remote_my-hooks_notify.ts")
    })

    test("generates correct name for plugin with dashes", () => {
      const plugin: PluginInfo = {
        name: "utils-helpers-logger",
        path: "/some/path/utils/helpers/logger.ts",
        repoShortName: "shared-plugins",
        extension: ".ts",
      }
      
      expect(getPluginSymlinkName(plugin)).toBe("_remote_shared-plugins_utils-helpers-logger.ts")
    })

    test("generates correct name for .js plugin", () => {
      const plugin: PluginInfo = {
        name: "legacy-hook",
        path: "/some/path/legacy-hook.js",
        repoShortName: "old-repo",
        extension: ".js",
      }
      
      expect(getPluginSymlinkName(plugin)).toBe("_remote_old-repo_legacy-hook.js")
    })

    test("handles underscores in names", () => {
      const plugin: PluginInfo = {
        name: "my_plugin_v2",
        path: "/some/path/my_plugin_v2.ts",
        repoShortName: "test_repo",
        extension: ".ts",
      }
      
      expect(getPluginSymlinkName(plugin)).toBe("_remote_test_repo_my_plugin_v2.ts")
    })
  })

  describe("isRemotePluginSymlink", () => {
    test("returns true for _remote_ prefixed names", () => {
      expect(isRemotePluginSymlink("_remote_my-repo_notify.ts")).toBe(true)
      expect(isRemotePluginSymlink("_remote_foo_bar.js")).toBe(true)
    })

    test("returns false for non-remote names", () => {
      expect(isRemotePluginSymlink("my-plugin.ts")).toBe(false)
      expect(isRemotePluginSymlink("remote_plugin.ts")).toBe(false)
      expect(isRemotePluginSymlink("_local_plugin.ts")).toBe(false)
    })
  })

  describe("ensurePluginDir", () => {
    test("creates directory if it does not exist", () => {
      const newDir = path.join(testPluginDir, "new-subdir")
      expect(fs.existsSync(newDir)).toBe(false)
      
      ensurePluginDir(newDir)
      
      expect(fs.existsSync(newDir)).toBe(true)
    })

    test("does nothing if directory already exists", () => {
      expect(fs.existsSync(testPluginDir)).toBe(true)
      
      ensurePluginDir(testPluginDir)
      
      expect(fs.existsSync(testPluginDir)).toBe(true)
    })
  })

  describe("createPluginSymlink", () => {
    test("creates symlink successfully", () => {
      // Create a source file to link to
      const sourceFile = path.join(testSourceDir, "source.ts")
      fs.writeFileSync(sourceFile, `export default {}`)
      
      const plugin: PluginInfo = {
        name: "test-plugin",
        path: sourceFile,
        repoShortName: "test-repo",
        extension: ".ts",
      }
      
      const result = createPluginSymlink(plugin, testPluginDir)
      
      expect(result.pluginName).toBe("test-plugin")
      expect(result.symlinkName).toBe("_remote_test-repo_test-plugin.ts")
      expect(result.targetPath).toBe(sourceFile)
      expect(result.error).toBeUndefined()
      
      // Verify symlink was actually created
      const symlinkPath = path.join(testPluginDir, "_remote_test-repo_test-plugin.ts")
      expect(fs.existsSync(symlinkPath)).toBe(true)
      expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true)
      expect(fs.readlinkSync(symlinkPath)).toBe(sourceFile)
    })

     test("replaces existing symlink", () => {
       const sourceFile1 = path.join(testSourceDir, "source1.ts")
       const sourceFile2 = path.join(testSourceDir, "source2.ts")
       fs.writeFileSync(sourceFile1, `export default { v: 1 }`)
       fs.writeFileSync(sourceFile2, `export default { v: 2 }`)
       
       const plugin1: PluginInfo = {
         name: "plugin",
         path: sourceFile1,
         repoShortName: "repo",
         extension: ".ts",
       }
       
       const plugin2: PluginInfo = {
         name: "plugin",
         path: sourceFile2,
         repoShortName: "repo",
         extension: ".ts",
       }
       
       createPluginSymlink(plugin1, testPluginDir)
       const result = createPluginSymlink(plugin2, testPluginDir)
       
       expect(result.error).toBeUndefined()
       
       // Verify symlink points to new source
       const symlinkPath = path.join(testPluginDir, "_remote_repo_plugin.ts")
       expect(fs.readlinkSync(symlinkPath)).toBe(sourceFile2)
     })

     test("handles broken symlinks (race condition)", () => {
       // This simulates the race condition where a symlink exists but points to a
       // now-nonexistent target (e.g., from a previous failed sync)
       const sourceFile1 = path.join(testSourceDir, "source1.ts")
       const sourceFile2 = path.join(testSourceDir, "source2.ts")
       fs.writeFileSync(sourceFile1, `export default { v: 1 }`)
       fs.writeFileSync(sourceFile2, `export default { v: 2 }`)
       
       const symlinkPath = path.join(testPluginDir, "_remote_repo_plugin.ts")
       
       // Create a symlink to a file that will be deleted
       fs.symlinkSync(sourceFile1, symlinkPath)
       expect(fs.existsSync(symlinkPath)).toBe(true)
       
       // Delete the target to make the symlink broken
       fs.unlinkSync(sourceFile1)
       expect(fs.existsSync(symlinkPath)).toBe(false) // Broken symlink
       expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true) // But it's still a symlink
       
       // Now try to create a new symlink to a different target
       const plugin: PluginInfo = {
         name: "plugin",
         path: sourceFile2,
         repoShortName: "repo",
         extension: ".ts",
       }
       
       const result = createPluginSymlink(plugin, testPluginDir)
       
       // Should succeed (not fail with EEXIST)
       expect(result.error).toBeUndefined()
       
       // Verify symlink now points to the new source
       expect(fs.readlinkSync(symlinkPath)).toBe(sourceFile2)
       expect(fs.existsSync(symlinkPath)).toBe(true)
     })

    test("reports error for non-existent source", () => {
      const plugin: PluginInfo = {
        name: "missing",
        path: "/non/existent/file.ts",
        repoShortName: "repo",
        extension: ".ts",
      }
      
      // Note: fs.symlinkSync doesn't check if target exists, so this will succeed
      // The error would only be visible when trying to read the symlink
      const result = createPluginSymlink(plugin, testPluginDir)
      
      // Symlink creation succeeds even for non-existent targets
      expect(result.error).toBeUndefined()
    })
  })

  describe("createPluginSymlinks", () => {
    test("creates symlinks for multiple plugins", () => {
      const sourceFile1 = path.join(testSourceDir, "plugin1.ts")
      const sourceFile2 = path.join(testSourceDir, "plugin2.js")
      fs.writeFileSync(sourceFile1, `export default {}`)
      fs.writeFileSync(sourceFile2, `module.exports = {}`)
      
      const plugins: PluginInfo[] = [
        {
          name: "plugin1",
          path: sourceFile1,
          repoShortName: "repo-a",
          extension: ".ts",
        },
        {
          name: "plugin2",
          path: sourceFile2,
          repoShortName: "repo-b",
          extension: ".js",
        },
      ]
      
      const results = createPluginSymlinks(plugins, testPluginDir)
      
      expect(results).toHaveLength(2)
      expect(results[0].symlinkName).toBe("_remote_repo-a_plugin1.ts")
      expect(results[1].symlinkName).toBe("_remote_repo-b_plugin2.js")
      
      // Verify both symlinks exist
      expect(fs.existsSync(path.join(testPluginDir, "_remote_repo-a_plugin1.ts"))).toBe(true)
      expect(fs.existsSync(path.join(testPluginDir, "_remote_repo-b_plugin2.js"))).toBe(true)
    })

    test("returns empty array for empty input", () => {
      const results = createPluginSymlinks([], testPluginDir)
      expect(results).toHaveLength(0)
    })
  })

  describe("getRemotePluginSymlinks", () => {
    test("returns empty array when directory does not exist", () => {
      const nonExistentDir = path.join(testPluginDir, "does-not-exist")
      const result = getRemotePluginSymlinks(nonExistentDir)
      expect(result).toEqual([])
    })

    test("returns empty array when directory is empty", () => {
      const result = getRemotePluginSymlinks(testPluginDir)
      expect(result).toEqual([])
    })

    test("returns only _remote_ prefixed files", () => {
      // Create some files
      fs.writeFileSync(path.join(testPluginDir, "_remote_repo_plugin1.ts"), "")
      fs.writeFileSync(path.join(testPluginDir, "_remote_other_plugin2.js"), "")
      fs.writeFileSync(path.join(testPluginDir, "local-plugin.ts"), "")
      fs.writeFileSync(path.join(testPluginDir, "another-local.js"), "")
      
      const result = getRemotePluginSymlinks(testPluginDir)
      
      expect(result).toHaveLength(2)
      expect(result.sort()).toEqual([
        "_remote_other_plugin2.js",
        "_remote_repo_plugin1.ts",
      ])
    })
  })

  describe("cleanupStalePluginSymlinks", () => {
    test("removes stale symlinks not in current set", () => {
      // Create some remote symlinks
      fs.writeFileSync(path.join(testPluginDir, "_remote_repo_keep.ts"), "")
      fs.writeFileSync(path.join(testPluginDir, "_remote_repo_remove1.ts"), "")
      fs.writeFileSync(path.join(testPluginDir, "_remote_repo_remove2.js"), "")
      fs.writeFileSync(path.join(testPluginDir, "local-plugin.ts"), "")
      
      const currentSymlinks = new Set(["_remote_repo_keep.ts"])
      const result = cleanupStalePluginSymlinks(currentSymlinks, testPluginDir)
      
      expect(result.removed.sort()).toEqual([
        "_remote_repo_remove1.ts",
        "_remote_repo_remove2.js",
      ])
      expect(result.errors).toEqual([])
      
      // Verify files are actually removed
      expect(fs.existsSync(path.join(testPluginDir, "_remote_repo_keep.ts"))).toBe(true)
      expect(fs.existsSync(path.join(testPluginDir, "_remote_repo_remove1.ts"))).toBe(false)
      expect(fs.existsSync(path.join(testPluginDir, "_remote_repo_remove2.js"))).toBe(false)
      // Local plugin should be untouched
      expect(fs.existsSync(path.join(testPluginDir, "local-plugin.ts"))).toBe(true)
    })

    test("returns empty removed array when no stale symlinks", () => {
      fs.writeFileSync(path.join(testPluginDir, "_remote_repo_plugin.ts"), "")
      
      const currentSymlinks = new Set(["_remote_repo_plugin.ts"])
      const result = cleanupStalePluginSymlinks(currentSymlinks, testPluginDir)
      
      expect(result.removed).toEqual([])
      expect(result.errors).toEqual([])
    })

    test("handles empty current set (removes all remote symlinks)", () => {
      fs.writeFileSync(path.join(testPluginDir, "_remote_repo_plugin1.ts"), "")
      fs.writeFileSync(path.join(testPluginDir, "_remote_repo_plugin2.ts"), "")
      
      const result = cleanupStalePluginSymlinks(new Set(), testPluginDir)
      
      expect(result.removed.sort()).toEqual([
        "_remote_repo_plugin1.ts",
        "_remote_repo_plugin2.ts",
      ])
    })
  })

  describe("getPluginSymlinkPath", () => {
    test("returns correct path with custom directory", () => {
      const result = getPluginSymlinkPath("_remote_repo_plugin.ts", testPluginDir)
      expect(result).toBe(path.join(testPluginDir, "_remote_repo_plugin.ts"))
    })
  })

  describe("symlink naming edge cases", () => {
    test("handles repo name with numbers", () => {
      const plugin: PluginInfo = {
        name: "hook",
        path: "/path/hook.ts",
        repoShortName: "my-repo-v2",
        extension: ".ts",
      }
      
      expect(getPluginSymlinkName(plugin)).toBe("_remote_my-repo-v2_hook.ts")
    })

    test("handles plugin name with numbers", () => {
      const plugin: PluginInfo = {
        name: "hook123",
        path: "/path/hook123.ts",
        repoShortName: "repo",
        extension: ".ts",
      }
      
      expect(getPluginSymlinkName(plugin)).toBe("_remote_repo_hook123.ts")
    })

    test("handles deeply nested plugin converted to dashes", () => {
      const plugin: PluginInfo = {
        name: "utils-helpers-formatters-date",
        path: "/path/utils/helpers/formatters/date.ts",
        repoShortName: "shared",
        extension: ".ts",
      }
      
      expect(getPluginSymlinkName(plugin)).toBe("_remote_shared_utils-helpers-formatters-date.ts")
    })
  })
})
