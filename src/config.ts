import { z } from "zod"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

/** Configuration file name */
const CONFIG_FILENAME = "remote-config.json"

/**
 * Schema for filter configuration with include or exclude list.
 * Cannot use both include and exclude at the same time.
 */
export const FilterConfigSchema = z.union([
  z.object({
    include: z.array(z.string()).min(1, "Include list must have at least one item"),
  }).strict(),
  z.object({
    exclude: z.array(z.string()).min(1, "Exclude list must have at least one item"),
  }).strict(),
])

export type FilterConfig = z.infer<typeof FilterConfigSchema>

/**
 * Schema for import configuration.
 * Can be "*" for all, or an object with include/exclude arrays.
 */
export const ImportConfigSchema = z.union([
  z.literal("*"),
  FilterConfigSchema,
])

export type ImportConfig = z.infer<typeof ImportConfigSchema>

/**
 * Schema for a single repository configuration.
 * Uses strict mode to reject unrecognized keys.
 */
export const RepositoryConfigSchema = z.object({
  /** Git URL (SSH or HTTPS) */
  url: z.string().min(1, "Repository URL is required"),
  
  /** Git ref to checkout (branch, tag, or commit SHA). Defaults to default branch. */
  ref: z.string().optional(),
  
  /** 
   * Skills to import.
   * Use "*" for all, { include: [...] } for specific skills, or { exclude: [...] } to import all except listed.
   * If omitted, imports all skills from the repository.
   */
  skills: ImportConfigSchema.optional(),
  
  /** 
   * Agents to import.
   * Use "*" for all, { include: [...] } for specific agents, or { exclude: [...] } to import all except listed.
   * If omitted, imports all agents from the repository.
   */
  agents: ImportConfigSchema.optional(),
  
  /** 
   * Commands to import.
   * Use "*" for all, { include: [...] } for specific commands, or { exclude: [...] } to import all except listed.
   * If omitted, imports all commands from the repository.
   */
  commands: ImportConfigSchema.optional(),
  
  /** 
   * Plugins to import.
   * Use "*" for all, { include: [...] } for specific plugins, or { exclude: [...] } to import all except listed.
   * If omitted, imports all plugins from the repository.
   * Plugins must be self-contained (no local imports).
   */
  plugins: ImportConfigSchema.optional(),
  
  /** 
   * Instructions to import.
   * Use "*" for all, { include: [...] } for specific instructions, or { exclude: [...] } to import all except listed.
   * If omitted, imports all instructions from the repository's manifest.
   */
  instructions: ImportConfigSchema.optional(),
}).strict()

/**
 * Check if an item should be imported based on the filter configuration.
 * 
 * @param name The name of the item to check
 * @param config The import configuration (undefined, "*", or filter object)
 * @returns true if the item should be imported, false otherwise
 */
export function shouldImport(name: string, config: ImportConfig | undefined): boolean {
  // If no config or "*", import everything
  if (config === undefined || config === "*") {
    return true
  }
  
  // If include list, only import if in the list
  if ("include" in config) {
    return config.include.includes(name)
  }
  
  // If exclude list, import if NOT in the list
  if ("exclude" in config) {
    return !config.exclude.includes(name)
  }
  
  // Fallback (should never happen with proper typing)
  return true
}

export type RepositoryConfig = z.infer<typeof RepositoryConfigSchema>

/**
 * Schema for the remote-config plugin configuration.
 * Uses strict mode to reject unrecognized keys.
 */
export const RemoteSkillsConfigSchema = z.object({
  /** Optional JSON Schema reference for editor support */
  $schema: z.string().optional(),
  
  repositories: z.array(RepositoryConfigSchema).default([]),
  
  /**
   * Sync mode:
   * - "blocking": Wait for sync to complete before OpenCode is ready (default)
   * - "background": Sync in background, notify user if updates available
   */
  sync: z.enum(["blocking", "background"]).default("blocking"),
  
  /**
   * How to install skills and plugins from remote repositories:
   * - "link": Create symlinks (default, fast, but may not work in containers)
   * - "copy": Copy files (works everywhere, uses rsync if available)
   */
  installMethod: z.enum(["link", "copy"]).default("link"),
}).strict()

export type RemoteSkillsConfig = z.infer<typeof RemoteSkillsConfigSchema>

/**
 * Default configuration when none is provided
 */
export const DEFAULT_CONFIG: RemoteSkillsConfig = {
  repositories: [],
  sync: "blocking",
  installMethod: "link",
}

/**
 * Result of loading configuration, including the source location
 */
export interface ConfigLoadResult {
  config: RemoteSkillsConfig
  /** The directory where the config was loaded from (e.g., ~/.config/opencode or ./opencode) */
  configDir: string | null
}

/**
 * Get the paths to search for the configuration file.
 * Searches in order:
 * 1. .opencode/remote-config.json (project-level)
 * 2. ~/.config/opencode/remote-config.json (global)
 */
export function getConfigPaths(): string[] {
  return [
    join(process.cwd(), ".opencode", CONFIG_FILENAME),
    join(homedir(), ".config", "opencode", CONFIG_FILENAME),
  ]
}

/**
 * Load and parse the plugin configuration from a file.
 * Searches project-level config first, then global config.
 * 
 * @returns Validated RemoteSkillsConfig
 */
export function loadConfig(): RemoteSkillsConfig {
  return loadConfigWithLocation().config
}

/**
 * Load and parse the plugin configuration from a file, returning the source location.
 * Searches project-level config first, then global config.
 * 
 * @returns Config and the directory it was loaded from
 */
export function loadConfigWithLocation(): ConfigLoadResult {
  const configPaths = getConfigPaths()
  
  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, "utf-8")
        const parsed = JSON.parse(content)
        const result = RemoteSkillsConfigSchema.safeParse(parsed)
        
        if (!result.success) {
          console.error(`[remote-config] Invalid configuration in ${configPath}:`, result.error.format())
          continue
        }
        
        // Extract the opencode config directory (parent of the config file)
        const configDir = join(configPath, "..")
        
        return { config: result.data, configDir }
      } catch (error) {
        console.error(`[remote-config] Error reading ${configPath}:`, error)
        continue
      }
    }
  }
  
  return { config: DEFAULT_CONFIG, configDir: null }
}

/**
 * Parse and validate plugin configuration from a raw object.
 * Used for testing and direct configuration.
 * 
 * @param config The raw config object
 * @returns Validated RemoteSkillsConfig
 */
export function parseConfig(config: unknown): RemoteSkillsConfig {
  if (!config || typeof config !== "object") {
    return DEFAULT_CONFIG
  }
  
  const result = RemoteSkillsConfigSchema.safeParse(config)
  
  if (!result.success) {
    console.error("[remote-config] Invalid configuration:", result.error.format())
    return DEFAULT_CONFIG
  }
  
  return result.data
}

/**
 * Generate a short name for a repository URL
 * Used for directory names and logging
 * 
 * @example
 * getRepoShortName("git@github.com:company/shared-skills.git") // "shared-skills"
 * getRepoShortName("https://github.com/team/skills-repo.git") // "skills-repo"
 * getRepoShortName("file:///path/to/my-skills") // "my-skills"
 */
export function getRepoShortName(url: string): string {
  // Handle file:// URLs - use the directory name
  if (url.startsWith("file://")) {
    const localPath = url.replace(/^file:\/\//, "")
    const basename = localPath.split("/").filter(Boolean).pop()
    if (basename) {
      return basename
    }
  }
  
  // Extract the repo name from the URL
  const match = url.match(/\/([^/]+?)(\.git)?$/)
  if (match) {
    return match[1]
  }
  
  // Fallback: use the whole URL, sanitized
  return url.replace(/[^a-zA-Z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 50)
}

/**
 * Generate a unique identifier for a repository URL
 * Used for cache directory names
 * 
 * @example
 * getRepoId("git@github.com:company/shared-skills.git") // "github.com-company-shared-skills"
 * getRepoId("file:///path/to/skills") // "local-path-to-skills"
 */
export function getRepoId(url: string): string {
  // Handle file:// URLs - use sanitized path
  if (url.startsWith("file://")) {
    const localPath = url.replace(/^file:\/\//, "")
    return "local-" + localPath.replace(/[^a-zA-Z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 90)
  }
  
  // Handle SSH URLs: git@github.com:org/repo.git
  const sshMatch = url.match(/^git@([^:]+):(.+?)(\.git)?$/)
  if (sshMatch) {
    const host = sshMatch[1]
    const path = sshMatch[2].replace(/\//g, "-")
    return `${host}-${path}`
  }
  
  // Handle HTTPS URLs: https://github.com/org/repo.git
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/(.+?)(\.git)?$/)
  if (httpsMatch) {
    const host = httpsMatch[1]
    const path = httpsMatch[2].replace(/\//g, "-")
    return `${host}-${path}`
  }
  
  // Fallback: sanitize the whole URL
  return url.replace(/[^a-zA-Z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 100)
}
