import { $ } from "bun"
import * as fs from "fs"
import * as path from "path"
import { logDebug, logError } from "./logging"

/** Cached result of rsync availability check */
let rsyncAvailable: boolean | null = null

/**
 * Detect if rsync is available on the system.
 * Result is cached after first call for performance.
 */
export async function detectRsync(): Promise<boolean> {
  if (rsyncAvailable !== null) {
    return rsyncAvailable
  }

  try {
    const result = await $`which rsync`.quiet()
    rsyncAvailable = result.exitCode === 0
  } catch {
    rsyncAvailable = false
  }

  return rsyncAvailable
}

/**
 * Copy a directory using rsync.
 * Uses rsync -a --delete to mirror source to target.
 * 
 * @param source Source directory path
 * @param target Target directory path
 */
async function copyWithRsync(source: string, target: string): Promise<void> {
  // Ensure target parent exists
  fs.mkdirSync(path.dirname(target), { recursive: true })

  // rsync -a --delete source/ target/
  // Trailing slash on source copies contents, not directory itself
  const result = await $`rsync -a --delete ${source}/ ${target}/`.quiet()

  if (result.exitCode !== 0) {
    throw new Error(`rsync failed: ${result.stderr.toString()}`)
  }
}

/**
 * Copy a directory using Node.js fs module.
 * Deletes target first for --delete equivalent behavior.
 * 
 * @param source Source directory path
 * @param target Target directory path
 */
function copyWithNodeFs(source: string, target: string): void {
  // Remove target if exists (equivalent to --delete)
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target)
    if (stat.isSymbolicLink() || stat.isFile()) {
      fs.unlinkSync(target)
    } else {
      fs.rmSync(target, { recursive: true, force: true })
    }
  }

  // Ensure parent exists
  fs.mkdirSync(path.dirname(target), { recursive: true })

  // Copy recursively
  fs.cpSync(source, target, { recursive: true })
}

/** Result of a syncDirectory operation */
export interface SyncDirectoryResult {
  method: "rsync" | "fs"
}

/**
 * Sync a directory from source to target.
 * Tries rsync first for performance, falls back to fs.cpSync.
 * 
 * @param source Source directory path
 * @param target Target directory path
 * @returns Object indicating which method was used
 * @throws Error if source doesn't exist, is not a directory, or paths overlap
 */
export async function syncDirectory(
  source: string,
  target: string
): Promise<SyncDirectoryResult> {
  // Validate source exists and is a directory
  let sourceStat: fs.Stats
  try {
    sourceStat = fs.statSync(source)
  } catch {
    throw new Error(`Source does not exist: ${source}`)
  }
  if (!sourceStat.isDirectory()) {
    throw new Error(`Source is not a directory: ${source}`)
  }

  // Check for overlapping paths (would cause infinite recursion or data loss)
  const resolvedSource = path.resolve(source)
  const resolvedTarget = path.resolve(target)
  if (resolvedTarget.startsWith(resolvedSource + path.sep)) {
    throw new Error(`Target cannot be inside source: ${target} is inside ${source}`)
  }
  if (resolvedSource.startsWith(resolvedTarget + path.sep)) {
    throw new Error(`Source cannot be inside target: ${source} is inside ${target}`)
  }

  const hasRsync = await detectRsync()

  if (hasRsync) {
    try {
      await copyWithRsync(source, target)
      logDebug(`Copied ${source} → ${target} using rsync`)
      return { method: "rsync" }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      logError(`rsync failed, falling back to fs: ${errorMessage}`)
      // Fall through to fs fallback
    }
  }

  try {
    copyWithNodeFs(source, target)
    logDebug(`Copied ${source} → ${target} using fs.cpSync`)
    return { method: "fs" }
  } catch (err) {
    // Clean up partial target on failure
    try {
      if (fs.existsSync(target)) {
        const stat = fs.lstatSync(target)
        if (stat.isSymbolicLink() || stat.isFile()) {
          fs.unlinkSync(target)
        } else {
          fs.rmSync(target, { recursive: true, force: true })
        }
      }
    } catch {
      // Ignore cleanup errors
    }
    throw err
  }
}

/**
 * Reset the rsync availability cache.
 * Useful for testing.
 */
export function resetRsyncCache(): void {
  rsyncAvailable = null
}

/**
 * Override the rsync availability value for testing.
 * Pass null to clear the override and allow re-detection.
 * 
 * @param value true (rsync available), false (rsync unavailable), or null (re-detect)
 */
export function setRsyncAvailable(value: boolean | null): void {
  rsyncAvailable = value
}
