import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { detectRsync, syncDirectory, resetRsyncCache, setRsyncAvailable } from "./copy"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

describe("copy", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "copy-test-"))
    resetRsyncCache()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    resetRsyncCache()
  })

  describe("detectRsync", () => {
    test("returns boolean", async () => {
      const result = await detectRsync()
      expect(typeof result).toBe("boolean")
    })

    test("caches result after first call", async () => {
      const first = await detectRsync()
      const second = await detectRsync()
      expect(first).toBe(second)
    })

    test("resetRsyncCache clears the cache", async () => {
      await detectRsync()
      resetRsyncCache()
      // After reset, detectRsync should re-check (we can't verify the check happened,
      // but we can verify it still returns a valid result)
      const result = await detectRsync()
      expect(typeof result).toBe("boolean")
    })

    test("setRsyncAvailable overrides detection to true", async () => {
      setRsyncAvailable(true)
      const result = await detectRsync()
      expect(result).toBe(true)
    })

    test("setRsyncAvailable overrides detection to false", async () => {
      setRsyncAvailable(false)
      const result = await detectRsync()
      expect(result).toBe(false)
    })
  })

  describe("syncDirectory", () => {
    test("copies directory contents to target", async () => {
      // Create source with files
      const source = path.join(tmpDir, "source")
      const target = path.join(tmpDir, "target")
      
      fs.mkdirSync(source, { recursive: true })
      fs.writeFileSync(path.join(source, "file1.txt"), "content1")
      fs.writeFileSync(path.join(source, "file2.txt"), "content2")
      
      const result = await syncDirectory(source, target)
      
      // Check result indicates method used
      expect(result.method).toMatch(/^(rsync|fs)$/)
      
      // Check files copied
      expect(fs.existsSync(path.join(target, "file1.txt"))).toBe(true)
      expect(fs.existsSync(path.join(target, "file2.txt"))).toBe(true)
      expect(fs.readFileSync(path.join(target, "file1.txt"), "utf-8")).toBe("content1")
      expect(fs.readFileSync(path.join(target, "file2.txt"), "utf-8")).toBe("content2")
    })

    test("copies nested directories", async () => {
      const source = path.join(tmpDir, "source")
      const target = path.join(tmpDir, "target")
      
      fs.mkdirSync(path.join(source, "subdir"), { recursive: true })
      fs.writeFileSync(path.join(source, "subdir", "nested.txt"), "nested content")
      
      await syncDirectory(source, target)
      
      expect(fs.existsSync(path.join(target, "subdir", "nested.txt"))).toBe(true)
      expect(fs.readFileSync(path.join(target, "subdir", "nested.txt"), "utf-8")).toBe("nested content")
    })

    test("creates target parent directories if needed", async () => {
      const source = path.join(tmpDir, "source")
      const target = path.join(tmpDir, "deep", "nested", "target")
      
      fs.mkdirSync(source, { recursive: true })
      fs.writeFileSync(path.join(source, "file.txt"), "content")
      
      await syncDirectory(source, target)
      
      expect(fs.existsSync(path.join(target, "file.txt"))).toBe(true)
    })

    test("deletes files in target that are not in source", async () => {
      const source = path.join(tmpDir, "source")
      const target = path.join(tmpDir, "target")
      
      // Create target with an extra file
      fs.mkdirSync(target, { recursive: true })
      fs.writeFileSync(path.join(target, "old-file.txt"), "should be deleted")
      
      // Create source with different file
      fs.mkdirSync(source, { recursive: true })
      fs.writeFileSync(path.join(source, "new-file.txt"), "new content")
      
      await syncDirectory(source, target)
      
      // Old file should be gone
      expect(fs.existsSync(path.join(target, "old-file.txt"))).toBe(false)
      // New file should exist
      expect(fs.existsSync(path.join(target, "new-file.txt"))).toBe(true)
    })

    test("returns method used (rsync or fs)", async () => {
      const source = path.join(tmpDir, "source")
      const target = path.join(tmpDir, "target")
      
      fs.mkdirSync(source, { recursive: true })
      fs.writeFileSync(path.join(source, "file.txt"), "content")
      
      const result = await syncDirectory(source, target)
      
      expect(["rsync", "fs"]).toContain(result.method)
    })

    test("uses rsync method when rsync is available", async () => {
      setRsyncAvailable(true)
      
      const source = path.join(tmpDir, "source")
      const target = path.join(tmpDir, "target")
      
      fs.mkdirSync(source, { recursive: true })
      fs.writeFileSync(path.join(source, "file.txt"), "content")
      
      const result = await syncDirectory(source, target)
      
      expect(result.method).toBe("rsync")
      expect(fs.existsSync(path.join(target, "file.txt"))).toBe(true)
    })

    test("uses fs method when rsync is unavailable", async () => {
      setRsyncAvailable(false)
      
      const source = path.join(tmpDir, "source")
      const target = path.join(tmpDir, "target")
      
      fs.mkdirSync(source, { recursive: true })
      fs.writeFileSync(path.join(source, "file.txt"), "content")
      
      const result = await syncDirectory(source, target)
      
      expect(result.method).toBe("fs")
      expect(fs.existsSync(path.join(target, "file.txt"))).toBe(true)
    })

    test("throws on source not existing", async () => {
      const source = path.join(tmpDir, "nonexistent")
      const target = path.join(tmpDir, "target")
      
      await expect(syncDirectory(source, target)).rejects.toThrow("Source does not exist")
    })

    test("throws when source is a file, not a directory", async () => {
      const source = path.join(tmpDir, "source-file.txt")
      const target = path.join(tmpDir, "target")
      
      fs.writeFileSync(source, "I am a file")
      
      await expect(syncDirectory(source, target)).rejects.toThrow("Source is not a directory")
    })

    test("throws when target is inside source", async () => {
      const source = path.join(tmpDir, "source")
      const target = path.join(tmpDir, "source", "nested", "target")
      
      fs.mkdirSync(source, { recursive: true })
      
      await expect(syncDirectory(source, target)).rejects.toThrow("Target cannot be inside source")
    })

    test("throws when source is inside target", async () => {
      const source = path.join(tmpDir, "parent", "source")
      const target = path.join(tmpDir, "parent")
      
      fs.mkdirSync(source, { recursive: true })
      
      await expect(syncDirectory(source, target)).rejects.toThrow("Source cannot be inside target")
    })

    test("cleans up partial target on failure", async () => {
      // Force fs method (not rsync) so we hit the cleanup code path
      setRsyncAvailable(false)
      
      const source = path.join(tmpDir, "source")
      const target = path.join(tmpDir, "target")
      
      // Create source with a subdirectory containing an unreadable file
      fs.mkdirSync(source, { recursive: true })
      fs.writeFileSync(path.join(source, "valid.txt"), "content")
      const unreadableDir = path.join(source, "unreadable")
      fs.mkdirSync(unreadableDir)
      fs.writeFileSync(path.join(unreadableDir, "file.txt"), "secret")
      // Remove read permission from directory - fs.cpSync will fail to read contents
      fs.chmodSync(unreadableDir, 0o000)
      
      try {
        // syncDirectory should fail due to unreadable directory
        await expect(syncDirectory(source, target)).rejects.toThrow()
        
        // Target should be cleaned up after failure
        expect(fs.existsSync(target)).toBe(false)
      } finally {
        // Restore permissions so afterEach cleanup can remove it
        fs.chmodSync(unreadableDir, 0o755)
      }
    })
  })
})
