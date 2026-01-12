import { $ } from "bun"
import * as path from "path"
import * as fs from "fs"
import matter from "gray-matter"
import { getRepoId, type RepositoryConfig } from "./config"
import { AgentConfigSchema, type AgentInfo } from "./agent"
import { CommandConfigSchema, type CommandInfo } from "./command"
import type { PluginInfo } from "./plugin-info"

/** Base directory for cloned repositories */
const CACHE_BASE = path.join(
  process.env.HOME || "~",
  ".cache",
  "opencode",
  "remote-config",
  "repos"
)

/**
 * Check if a URL is a file:// URL (local directory)
 */
export function isFileUrl(url: string): boolean {
  return url.startsWith("file://")
}

/**
 * Convert a file:// URL to a local path
 */
export function fileUrlToPath(url: string): string {
  // Handle file:///path/to/dir and file://path/to/dir
  const withoutPrefix = url.replace(/^file:\/\//, "")
  // Normalize the path
  return path.resolve(withoutPrefix)
}

/**
 * Information about a skill found in a repository
 */
export interface SkillInfo {
  name: string
  path: string
  description?: string
}

/**
 * Result of syncing a repository
 */
export interface SyncResult {
  repoId: string
  repoPath: string
  shortName: string
  ref: string
  skills: SkillInfo[]
  agents: AgentInfo[]
  commands: CommandInfo[]
  plugins: PluginInfo[]
  updated: boolean
  error?: string
}

// Re-export types for convenience
export type { AgentInfo } from "./agent"
export type { CommandInfo } from "./command"
export type { PluginInfo } from "./plugin-info"

/**
 * Get the local path where a repository should be cloned
 */
export function getRepoPath(url: string): string {
  const repoId = getRepoId(url)
  return path.join(CACHE_BASE, repoId)
}

/**
 * Check if a repository has already been cloned
 */
export function isCloned(repoPath: string): boolean {
  return fs.existsSync(path.join(repoPath, ".git"))
}

/**
 * Clone a repository (full clone, not shallow)
 */
async function cloneRepo(url: string, repoPath: string): Promise<void> {
  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(repoPath), { recursive: true })
  
  const result = await $`git clone ${url} ${repoPath}`.quiet()
  
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim()
    const stdout = result.stdout.toString().trim()
    // Git sometimes writes to stdout, sometimes to stderr - capture both
    const output = [stderr, stdout].filter(Boolean).join("\n") || `exit code ${result.exitCode}`
    throw new Error(`git clone failed: ${output}`)
  }
}

/**
 * Fetch updates and checkout a specific ref
 */
async function fetchAndCheckout(repoPath: string, ref?: string): Promise<boolean> {
  // Get current commit before fetch
  const beforeCommit = await $`git -C ${repoPath} rev-parse HEAD`.quiet()
  const beforeHash = beforeCommit.stdout.toString().trim()
  
  // Fetch all updates
  const fetchResult = await $`git -C ${repoPath} fetch --all --prune`.quiet()
  if (fetchResult.exitCode !== 0) {
    const stderr = fetchResult.stderr.toString().trim()
    const stdout = fetchResult.stdout.toString().trim()
    const output = [stderr, stdout].filter(Boolean).join("\n") || `exit code ${fetchResult.exitCode}`
    throw new Error(`git fetch failed: ${output}`)
  }
  
  if (ref) {
    // Checkout specific ref (branch, tag, or commit)
    const checkoutResult = await $`git -C ${repoPath} checkout ${ref}`.quiet()
    
    if (checkoutResult.exitCode !== 0) {
      const stderr = checkoutResult.stderr.toString().trim()
      const stdout = checkoutResult.stdout.toString().trim()
      const output = [stderr, stdout].filter(Boolean).join("\n") || `exit code ${checkoutResult.exitCode}`
      throw new Error(`git checkout ${ref} failed: ${output}`)
    }
    
    // If it's a branch, pull latest
    const isBranch = await $`git -C ${repoPath} symbolic-ref -q HEAD`.quiet()
    if (isBranch.exitCode === 0) {
      const pullResult = await $`git -C ${repoPath} pull --ff-only`.quiet()
      if (pullResult.exitCode !== 0) {
        const stderr = pullResult.stderr.toString().trim()
        const stdout = pullResult.stdout.toString().trim()
        const output = [stderr, stdout].filter(Boolean).join("\n") || `exit code ${pullResult.exitCode}`
        throw new Error(`git pull failed: ${output}`)
      }
    }
  } else {
    // No ref specified, checkout default branch and pull
    const defaultBranch = await $`git -C ${repoPath} symbolic-ref refs/remotes/origin/HEAD`.quiet()
    if (defaultBranch.exitCode === 0) {
      const branch = defaultBranch.stdout.toString().trim().replace("refs/remotes/origin/", "")
      await $`git -C ${repoPath} checkout ${branch}`.quiet()
      await $`git -C ${repoPath} pull --ff-only`.quiet()
    }
  }
  
  // Get commit after checkout
  const afterCommit = await $`git -C ${repoPath} rev-parse HEAD`.quiet()
  const afterHash = afterCommit.stdout.toString().trim()
  
  return beforeHash !== afterHash
}

/**
 * Get the current ref (branch name or commit) of a repository
 */
async function getCurrentRef(repoPath: string): Promise<string> {
  // Try to get branch name
  const branchResult = await $`git -C ${repoPath} symbolic-ref --short HEAD`.quiet()
  if (branchResult.exitCode === 0) {
    return branchResult.stdout.toString().trim()
  }
  
  // Fall back to commit hash
  const commitResult = await $`git -C ${repoPath} rev-parse --short HEAD`.quiet()
  return commitResult.stdout.toString().trim()
}

/**
 * Discover skills in a repository
 * Skills are directories containing a SKILL.md file
 * Looks for both "skill/" and "skills/" directories
 */
export async function discoverSkills(repoPath: string): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = []
  
  // Support both "skill/" (OpenCode convention) and "skills/" (common alternative)
  let skillDir = path.join(repoPath, "skill")
  if (!fs.existsSync(skillDir)) {
    skillDir = path.join(repoPath, "skills")
  }
  
  if (!fs.existsSync(skillDir)) {
    return skills
  }
  
  // Recursively find SKILL.md files
  const findSkills = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      
      const fullPath = path.join(dir, entry.name)
      
      if (entry.isDirectory()) {
        const skillMdPath = path.join(fullPath, "SKILL.md")
        
        if (fs.existsSync(skillMdPath)) {
          // Extract skill name from the directory path relative to skill/
          const relativePath = path.relative(skillDir, fullPath)
          const skillName = relativePath.replace(/\//g, "-")
          
          // Try to extract description from frontmatter
          let description: string | undefined
          try {
            const content = fs.readFileSync(skillMdPath, "utf-8")
            const match = content.match(/^---\n[\s\S]*?description:\s*(.+?)\n[\s\S]*?---/m)
            if (match) {
              description = match[1].trim().replace(/^["']|["']$/g, "")
            }
          } catch {
            // Ignore parse errors
          }
          
          skills.push({
            name: skillName,
            path: fullPath,
            description,
          })
        } else {
          // Recurse into subdirectory
          findSkills(fullPath)
        }
      }
    }
  }
  
  findSkills(skillDir)
  return skills
}

/** Discovery limits to prevent DoS from large/malicious repositories */
const DISCOVERY_LIMITS = {
  /** Maximum number of agent files to process */
  maxFiles: 100,
  /** Maximum file size in bytes (256KB) */
  maxFileSize: 256 * 1024,
  /** Maximum directory depth to traverse */
  maxDepth: 10,
}

/**
 * Discover agents in a repository.
 * Agents are markdown files in agent/ or agents/ directories.
 * Supports nested directories: agent/category/name.md → "category/name"
 * 
 * Limits are applied to prevent DoS:
 * - Max 100 agent files
 * - Max 256KB per file
 * - Max 10 levels of directory nesting
 */
export async function discoverAgents(repoPath: string): Promise<AgentInfo[]> {
  const agents: AgentInfo[] = []
  let filesProcessed = 0
  let limitsWarned = false
  
  // Support both "agent/" and "agents/"
  let agentDir = path.join(repoPath, "agent")
  if (!fs.existsSync(agentDir)) {
    agentDir = path.join(repoPath, "agents")
  }
  
  if (!fs.existsSync(agentDir)) {
    return agents
  }
  
  // Recursively find *.md files with limits
  const findAgents = (dir: string, depth: number) => {
    // Check depth limit
    if (depth > DISCOVERY_LIMITS.maxDepth) {
      if (!limitsWarned) {
        console.warn(`[remote-config] Skipping deep directories (max depth: ${DISCOVERY_LIMITS.maxDepth})`)
        limitsWarned = true
      }
      return
    }
    
    // Check file count limit
    if (filesProcessed >= DISCOVERY_LIMITS.maxFiles) {
      if (!limitsWarned) {
        console.warn(`[remote-config] Stopping discovery (max files: ${DISCOVERY_LIMITS.maxFiles})`)
        limitsWarned = true
      }
      return
    }
    
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      if (filesProcessed >= DISCOVERY_LIMITS.maxFiles) break
      
      const fullPath = path.join(dir, entry.name)
      
      if (entry.isDirectory()) {
        findAgents(fullPath, depth + 1)
      } else if (entry.name.toLowerCase().endsWith(".md")) {
        // Check file size before reading
        try {
          const stats = fs.statSync(fullPath)
          if (stats.size > DISCOVERY_LIMITS.maxFileSize) {
            console.warn(`[remote-config] Skipping large file (${Math.round(stats.size / 1024)}KB): ${entry.name}`)
            continue
          }
          
          filesProcessed++
          const content = fs.readFileSync(fullPath, "utf-8")
          const parsed = parseAgentMarkdown(fullPath, content, agentDir)
          if (parsed) {
            agents.push(parsed)
          }
        } catch (err) {
          console.error(`[remote-config] Failed to parse agent ${fullPath}:`, err)
        }
      }
    }
  }
  
  findAgents(agentDir, 0)
  return agents
}

/**
 * Parse an agent markdown file into AgentInfo.
 * Follows OpenCode's naming convention for nested agents.
 */
function parseAgentMarkdown(
  filePath: string, 
  content: string, 
  agentDir: string
): AgentInfo | null {
  let md: matter.GrayMatterFile<string>
  
  try {
    // Use YAML-only parsing for security. By default gray-matter supports
    // JavaScript frontmatter (---js) which uses eval() - dangerous for untrusted content.
    // We explicitly disable JavaScript/CoffeeScript engines to prevent code execution.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const yamlEngine = require("gray-matter/lib/engines").yaml
    const disabledEngine = () => { 
      throw new Error("JavaScript/CoffeeScript frontmatter is disabled for security") 
    }
    md = matter(content, {
      language: "yaml",
      engines: {
        yaml: yamlEngine,
        javascript: disabledEngine,
        coffee: disabledEngine,
        json: JSON.parse.bind(JSON), // JSON is safe
      },
    })
  } catch (err) {
    // Log with repo-relative path to avoid exposing absolute paths
    const relativeToRepo = path.relative(path.dirname(agentDir), filePath)
    console.error(`[remote-config] Failed to parse frontmatter in ${relativeToRepo}:`, err)
    return null
  }
  
  // Skip files without frontmatter (not an agent definition)
  if (!md.data || Object.keys(md.data).length === 0) {
    return null
  }
  
  // Calculate agent name from path (matching OpenCode's logic)
  // Normalize path separators for cross-platform consistency (Windows uses \)
  const relativePath = path.relative(agentDir, filePath).replace(/\\/g, "/")
  // Handle case-insensitive .md extension (e.g., .MD, .Md)
  const agentName = relativePath.replace(/\.md$/i, "")
  
  // Validate agent name contains only safe characters
  // Allow: alphanumeric, hyphens, underscores, and forward slashes (for nesting)
  if (!/^[a-zA-Z0-9_/-]+$/.test(agentName)) {
    const relativeToRepo = path.relative(path.dirname(agentDir), filePath)
    console.warn(`[remote-config] Skipping agent with invalid name characters: ${relativeToRepo}`)
    return null
  }
  
  // Build config: frontmatter + body as prompt
  const rawConfig = {
    ...md.data,
    prompt: md.content.trim() || undefined,
  }
  
  // Validate against schema
  const result = AgentConfigSchema.safeParse(rawConfig)
  if (!result.success) {
    console.error(`[remote-config] Invalid agent config in ${filePath}:`, 
      result.error.format())
    return null
  }
  
  return {
    name: agentName,
    path: filePath,
    config: result.data,
  }
}

/**
 * Discover commands in a repository.
 * Commands are markdown files in command/ or commands/ directories.
 * Supports nested directories: command/category/name.md → "category/name"
 * 
 * Commands are slash commands with templates that users invoke like /review or /deploy/staging.
 * 
 * Limits are applied to prevent DoS:
 * - Max 100 command files
 * - Max 256KB per file
 * - Max 10 levels of directory nesting
 */
export async function discoverCommands(repoPath: string): Promise<CommandInfo[]> {
  const commands: CommandInfo[] = []
  let filesProcessed = 0
  let limitsWarned = false
  
  // Support both "command/" and "commands/"
  let commandDir = path.join(repoPath, "command")
  if (!fs.existsSync(commandDir)) {
    commandDir = path.join(repoPath, "commands")
  }
  
  if (!fs.existsSync(commandDir)) {
    return commands
  }
  
  // Recursively find *.md files with limits
  const findCommands = (dir: string, depth: number) => {
    // Check depth limit
    if (depth > DISCOVERY_LIMITS.maxDepth) {
      if (!limitsWarned) {
        console.warn(`[remote-config] Skipping deep directories (max depth: ${DISCOVERY_LIMITS.maxDepth})`)
        limitsWarned = true
      }
      return
    }
    
    // Check file count limit
    if (filesProcessed >= DISCOVERY_LIMITS.maxFiles) {
      if (!limitsWarned) {
        console.warn(`[remote-config] Stopping discovery (max files: ${DISCOVERY_LIMITS.maxFiles})`)
        limitsWarned = true
      }
      return
    }
    
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      if (filesProcessed >= DISCOVERY_LIMITS.maxFiles) break
      
      const fullPath = path.join(dir, entry.name)
      
      if (entry.isDirectory()) {
        findCommands(fullPath, depth + 1)
      } else if (entry.name.toLowerCase().endsWith(".md")) {
        // Check file size before reading
        try {
          const stats = fs.statSync(fullPath)
          if (stats.size > DISCOVERY_LIMITS.maxFileSize) {
            console.warn(`[remote-config] Skipping large file (${Math.round(stats.size / 1024)}KB): ${entry.name}`)
            continue
          }
          
          filesProcessed++
          const content = fs.readFileSync(fullPath, "utf-8")
          const parsed = parseCommandMarkdown(fullPath, content, commandDir)
          if (parsed) {
            commands.push(parsed)
          }
        } catch (err) {
          console.error(`[remote-config] Failed to parse command ${fullPath}:`, err)
        }
      }
    }
  }
  
  findCommands(commandDir, 0)
  return commands
}

/**
 * Parse a command markdown file into CommandInfo.
 * Follows OpenCode's naming convention for nested commands.
 */
function parseCommandMarkdown(
  filePath: string, 
  content: string, 
  commandDir: string
): CommandInfo | null {
  let md: matter.GrayMatterFile<string>
  
  try {
    // Use YAML-only parsing for security. By default gray-matter supports
    // JavaScript frontmatter (---js) which uses eval() - dangerous for untrusted content.
    // We explicitly disable JavaScript/CoffeeScript engines to prevent code execution.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const yamlEngine = require("gray-matter/lib/engines").yaml
    const disabledEngine = () => { 
      throw new Error("JavaScript/CoffeeScript frontmatter is disabled for security") 
    }
    md = matter(content, {
      language: "yaml",
      engines: {
        yaml: yamlEngine,
        javascript: disabledEngine,
        coffee: disabledEngine,
        json: JSON.parse.bind(JSON), // JSON is safe
      },
    })
  } catch (err) {
    // Log with repo-relative path to avoid exposing absolute paths
    const relativeToRepo = path.relative(path.dirname(commandDir), filePath)
    console.error(`[remote-config] Failed to parse frontmatter in ${relativeToRepo}:`, err)
    return null
  }
  
  // Commands don't require frontmatter - the directory structure indicates intent.
  // If no frontmatter, the entire body becomes the template.
  
  // Calculate command name from path (matching OpenCode's logic)
  // Normalize path separators for cross-platform consistency (Windows uses \)
  const relativePath = path.relative(commandDir, filePath).replace(/\\/g, "/")
  // Handle case-insensitive .md extension (e.g., .MD, .Md)
  const commandName = relativePath.replace(/\.md$/i, "")
  
  // Validate command name contains only safe characters
  // Allow: alphanumeric, hyphens, underscores, and forward slashes (for nesting)
  if (!/^[a-zA-Z0-9_/-]+$/.test(commandName)) {
    const relativeToRepo = path.relative(path.dirname(commandDir), filePath)
    console.warn(`[remote-config] Skipping command with invalid name characters: ${relativeToRepo}`)
    return null
  }
  
  // Build config: frontmatter values
  // If template is not in frontmatter, use the body as the template
  const rawConfig = {
    ...md.data,
    template: md.data.template || md.content.trim() || undefined,
  }
  
  // Validate against schema
  const result = CommandConfigSchema.safeParse(rawConfig)
  if (!result.success) {
    console.error(`[remote-config] Invalid command config in ${filePath}:`, 
      result.error.format())
    return null
  }
  
  return {
    name: commandName,
    path: filePath,
    config: result.data,
  }
}

/**
 * Discover plugins in a repository.
 * Plugins are .ts or .js files in plugin/ or plugins/ directories.
 * Supports nested directories: plugin/utils/logger.ts → "utils-logger"
 * 
 * Plugins are self-contained hook files that export OpenCode hooks.
 * They must not have local imports (./foo, ../bar) - only npm packages.
 * 
 * Limits are applied to prevent DoS:
 * - Max 100 plugin files
 * - Max 256KB per file
 * - Max 10 levels of directory nesting
 */
export async function discoverPlugins(repoPath: string, repoShortName: string): Promise<PluginInfo[]> {
  const plugins: PluginInfo[] = []
  let filesProcessed = 0
  let limitsWarned = false
  
  // Support both "plugin/" and "plugins/"
  let pluginDir = path.join(repoPath, "plugin")
  if (!fs.existsSync(pluginDir)) {
    pluginDir = path.join(repoPath, "plugins")
  }
  
  if (!fs.existsSync(pluginDir)) {
    return plugins
  }
  
  // Recursively find *.ts and *.js files with limits
  const findPlugins = (dir: string, depth: number) => {
    // Check depth limit
    if (depth > DISCOVERY_LIMITS.maxDepth) {
      if (!limitsWarned) {
        console.warn(`[remote-config] Skipping deep directories (max depth: ${DISCOVERY_LIMITS.maxDepth})`)
        limitsWarned = true
      }
      return
    }
    
    // Check file count limit
    if (filesProcessed >= DISCOVERY_LIMITS.maxFiles) {
      if (!limitsWarned) {
        console.warn(`[remote-config] Stopping discovery (max files: ${DISCOVERY_LIMITS.maxFiles})`)
        limitsWarned = true
      }
      return
    }
    
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      if (filesProcessed >= DISCOVERY_LIMITS.maxFiles) break
      
      const fullPath = path.join(dir, entry.name)
      
      if (entry.isDirectory()) {
        findPlugins(fullPath, depth + 1)
      } else if (entry.name.toLowerCase().endsWith(".ts") || entry.name.toLowerCase().endsWith(".js")) {
        // Check file size before processing
        try {
          const stats = fs.statSync(fullPath)
          if (stats.size > DISCOVERY_LIMITS.maxFileSize) {
            console.warn(`[remote-config] Skipping large file (${Math.round(stats.size / 1024)}KB): ${entry.name}`)
            continue
          }
          
          filesProcessed++
          
          // Calculate plugin name from path
          // Normalize path separators for cross-platform consistency (Windows uses \)
          const relativePath = path.relative(pluginDir, fullPath).replace(/\\/g, "/")
          // Get extension
          const ext = path.extname(relativePath)
          // Remove extension and convert path separators to dashes
          const pluginName = relativePath.slice(0, -ext.length).replace(/\//g, "-")
          
          // Validate plugin name contains only safe characters
          // Allow: alphanumeric, hyphens, underscores
          if (!/^[a-zA-Z0-9_-]+$/.test(pluginName)) {
            const relativeToRepo = path.relative(path.dirname(pluginDir), fullPath)
            console.warn(`[remote-config] Skipping plugin with invalid name characters: ${relativeToRepo}`)
            continue
          }
          
          plugins.push({
            name: pluginName,
            path: fullPath,
            repoShortName,
            extension: ext,
          })
        } catch (err) {
          console.error(`[remote-config] Failed to process plugin ${fullPath}:`, err)
        }
      }
    }
  }
  
  findPlugins(pluginDir, 0)
  return plugins
}

/**
 * Sync a single repository
 * 
 * @param config Repository configuration
 * @returns Sync result with discovered skills
 */
export async function syncRepository(config: RepositoryConfig): Promise<SyncResult> {
  // Handle file:// URLs (local directories)
  if (isFileUrl(config.url)) {
    return syncLocalDirectory(config)
  }
  
  // Handle git URLs
  return syncGitRepository(config)
}

/**
 * Sync a local directory (file:// URL)
 * No cloning needed - directly use the local path
 */
async function syncLocalDirectory(config: RepositoryConfig): Promise<SyncResult> {
  const localPath = fileUrlToPath(config.url)
  const repoId = getRepoId(config.url)
  const shortName = path.basename(localPath)
  
  let error: string | undefined
  let skills: SkillInfo[] = []
  let agents: AgentInfo[] = []
  let commands: CommandInfo[] = []
  let plugins: PluginInfo[] = []
  
  // Check if the directory exists
  if (!fs.existsSync(localPath)) {
    error = `Local directory not found: ${localPath}`
  } else if (!fs.statSync(localPath).isDirectory()) {
    error = `Not a directory: ${localPath}`
  } else {
    // Discover skills directly from the local directory
    skills = await discoverSkills(localPath)
    
    // Filter skills if specific ones are requested
    if (config.skills && config.skills !== "*" && Array.isArray(config.skills)) {
      const requestedSkills = new Set(config.skills)
      skills = skills.filter(s => requestedSkills.has(s.name))
    }
    
    // Discover agents directly from the local directory
    agents = await discoverAgents(localPath)
    
    // Filter agents if specific ones are requested
    if (config.agents && config.agents !== "*" && Array.isArray(config.agents)) {
      const requestedAgents = new Set(config.agents)
      agents = agents.filter(a => requestedAgents.has(a.name))
    }
    
    // Discover commands directly from the local directory
    commands = await discoverCommands(localPath)
    
    // Filter commands if specific ones are requested
    if (config.commands && config.commands !== "*" && Array.isArray(config.commands)) {
      const requestedCommands = new Set(config.commands)
      commands = commands.filter(c => requestedCommands.has(c.name))
    }
    
    // Discover plugins directly from the local directory
    plugins = await discoverPlugins(localPath, shortName)
    
    // Filter plugins if specific ones are requested
    if (config.plugins && config.plugins !== "*" && Array.isArray(config.plugins)) {
      const requestedPlugins = new Set(config.plugins)
      plugins = plugins.filter(p => requestedPlugins.has(p.name))
    }
  }
  
  return {
    repoId,
    repoPath: localPath,
    shortName,
    ref: "local",
    skills,
    agents,
    commands,
    plugins,
    updated: false, // Local directories don't have an "updated" concept
    error,
  }
}

/**
 * Sync a git repository
 */
async function syncGitRepository(config: RepositoryConfig): Promise<SyncResult> {
  const repoId = getRepoId(config.url)
  const repoPath = getRepoPath(config.url)
  const shortName = config.url.match(/\/([^/]+?)(\.git)?$/)?.[1] || repoId
  
  let updated = false
  let error: string | undefined
  
  try {
    if (!isCloned(repoPath)) {
      // Clone the repository
      await cloneRepo(config.url, repoPath)
      updated = true
      
      // Checkout specific ref if provided
      if (config.ref) {
        await fetchAndCheckout(repoPath, config.ref)
      }
    } else {
      // Fetch and checkout
      updated = await fetchAndCheckout(repoPath, config.ref)
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  
  // Discover skills, agents, commands, and plugins even if there was an update error
  let skills: SkillInfo[] = []
  let agents: AgentInfo[] = []
  let commands: CommandInfo[] = []
  let plugins: PluginInfo[] = []
  let currentRef = config.ref || "default"
  
  if (isCloned(repoPath)) {
    skills = await discoverSkills(repoPath)
    currentRef = await getCurrentRef(repoPath)
    
    // Filter skills if specific ones are requested
    if (config.skills && config.skills !== "*" && Array.isArray(config.skills)) {
      const requestedSkills = new Set(config.skills)
      skills = skills.filter(s => requestedSkills.has(s.name))
    }
    
    // Discover agents
    agents = await discoverAgents(repoPath)
    
    // Filter agents if specific ones are requested
    if (config.agents && config.agents !== "*" && Array.isArray(config.agents)) {
      const requestedAgents = new Set(config.agents)
      agents = agents.filter(a => requestedAgents.has(a.name))
    }
    
    // Discover commands
    commands = await discoverCommands(repoPath)
    
    // Filter commands if specific ones are requested
    if (config.commands && config.commands !== "*" && Array.isArray(config.commands)) {
      const requestedCommands = new Set(config.commands)
      commands = commands.filter(c => requestedCommands.has(c.name))
    }
    
    // Discover plugins
    plugins = await discoverPlugins(repoPath, shortName)
    
    // Filter plugins if specific ones are requested
    if (config.plugins && config.plugins !== "*" && Array.isArray(config.plugins)) {
      const requestedPlugins = new Set(config.plugins)
      plugins = plugins.filter(p => requestedPlugins.has(p.name))
    }
  }
  
  return {
    repoId,
    repoPath,
    shortName,
    ref: currentRef,
    skills,
    agents,
    commands,
    plugins,
    updated,
    error,
  }
}

/**
 * Sync multiple repositories
 */
export async function syncRepositories(
  configs: RepositoryConfig[]
): Promise<SyncResult[]> {
  const results: SyncResult[] = []
  
  for (const config of configs) {
    const result = await syncRepository(config)
    results.push(result)
  }
  
  return results
}
