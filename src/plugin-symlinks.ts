import * as fs from "fs"
import * as path from "path"
import { homedir } from "os"
import type { PluginInfo } from "./plugin-info"

/** Default directory where OpenCode looks for plugins */
const DEFAULT_PLUGIN_DIR = path.join(homedir(), ".config", "opencode", "plugin")

/** Prefix for remote plugin symlinks */
const REMOTE_PREFIX = "_remote_"

/** Get the plugin directory (default or overridden for testing) */
export function getPluginDir(): string {
  return DEFAULT_PLUGIN_DIR
}

/**
 * Result of creating a plugin symlink
 */
export interface PluginSymlinkResult {
  pluginName: string
  symlinkName: string
  symlinkPath: string
  targetPath: string
  error?: string
}

/**
 * Result of cleaning up plugin symlinks
 */
export interface PluginCleanupResult {
  removed: string[]
  errors: string[]
}

/**
 * Get the symlink name for a plugin.
 * Format: _remote_<repo>_<plugin-name>.<ext>
 * 
 * @example
 * getPluginSymlinkName({ name: "notify", repoShortName: "my-hooks", extension: ".ts" })
 * // Returns: "_remote_my-hooks_notify.ts"
 */
export function getPluginSymlinkName(plugin: PluginInfo): string {
  return `${REMOTE_PREFIX}${plugin.repoShortName}_${plugin.name}${plugin.extension}`
}

/**
 * Ensure the plugin directory exists
 * @param pluginDir Optional directory to use (defaults to ~/.config/opencode/plugin)
 */
export function ensurePluginDir(pluginDir: string = DEFAULT_PLUGIN_DIR): void {
  if (!fs.existsSync(pluginDir)) {
    fs.mkdirSync(pluginDir, { recursive: true })
  }
}

/**
 * Create a symlink for a single plugin
 * @param plugin Plugin info
 * @param pluginDir Optional directory to use (defaults to ~/.config/opencode/plugin)
 */
export function createPluginSymlink(plugin: PluginInfo, pluginDir: string = DEFAULT_PLUGIN_DIR): PluginSymlinkResult {
  const symlinkName = getPluginSymlinkName(plugin)
  const symlinkPath = path.join(pluginDir, symlinkName)
  
  const result: PluginSymlinkResult = {
    pluginName: plugin.name,
    symlinkName,
    symlinkPath,
    targetPath: plugin.path,
  }
  
   try {
     ensurePluginDir(pluginDir)
     
     // Remove existing symlink if it exists (including broken symlinks)
     // fs.existsSync returns false for broken symlinks, so use lstatSync instead
     try {
       fs.lstatSync(symlinkPath)
       fs.unlinkSync(symlinkPath)
     } catch (err) {
       // File doesn't exist, which is fine
       if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
         throw err
       }
     }
     
     // Create symlink
     fs.symlinkSync(plugin.path, symlinkPath)
   } catch (err) {
     result.error = err instanceof Error ? err.message : String(err)
   }
  
  return result
}

/**
 * Create symlinks for multiple plugins
 * @param plugins List of plugins
 * @param pluginDir Optional directory to use (defaults to ~/.config/opencode/plugin)
 */
export function createPluginSymlinks(plugins: PluginInfo[], pluginDir: string = DEFAULT_PLUGIN_DIR): PluginSymlinkResult[] {
  return plugins.map(p => createPluginSymlink(p, pluginDir))
}

/**
 * Get all existing remote plugin symlinks
 * Returns the symlink filenames (not full paths)
 * @param pluginDir Optional directory to use (defaults to ~/.config/opencode/plugin)
 */
export function getRemotePluginSymlinks(pluginDir: string = DEFAULT_PLUGIN_DIR): string[] {
  if (!fs.existsSync(pluginDir)) {
    return []
  }
  
  try {
    const entries = fs.readdirSync(pluginDir)
    return entries.filter(name => name.startsWith(REMOTE_PREFIX))
  } catch {
    return []
  }
}

/**
 * Clean up stale plugin symlinks.
 * Removes any _remote_* symlinks that are not in the current set.
 * 
 * @param currentSymlinks Set of symlink names that should exist
 * @param pluginDir Optional directory to use (defaults to ~/.config/opencode/plugin)
 */
export function cleanupStalePluginSymlinks(currentSymlinks: Set<string>, pluginDir: string = DEFAULT_PLUGIN_DIR): PluginCleanupResult {
  const result: PluginCleanupResult = {
    removed: [],
    errors: [],
  }
  
  const existing = getRemotePluginSymlinks(pluginDir)
  
  for (const name of existing) {
    if (!currentSymlinks.has(name)) {
      const symlinkPath = path.join(pluginDir, name)
      try {
        fs.unlinkSync(symlinkPath)
        result.removed.push(name)
      } catch (err) {
        result.errors.push(`Failed to remove ${name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  
  return result
}

/**
 * Get the full path to a plugin symlink
 * @param symlinkName Symlink filename
 * @param pluginDir Optional directory to use (defaults to ~/.config/opencode/plugin)
 */
export function getPluginSymlinkPath(symlinkName: string, pluginDir: string = DEFAULT_PLUGIN_DIR): string {
  return path.join(pluginDir, symlinkName)
}

/**
 * Check if a symlink name is a remote plugin symlink
 */
export function isRemotePluginSymlink(name: string): boolean {
  return name.startsWith(REMOTE_PREFIX)
}
