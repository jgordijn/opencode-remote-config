import type { Plugin } from "@opencode-ai/plugin"
import { loadConfig, type RemoteSkillsConfig } from "./config"
import { syncRepositories, type SyncResult } from "./git"
import type { AgentConfig } from "./agent"
import type { CommandConfig } from "./command"
import {
  createSymlinksForRepo,
  cleanupStaleSymlinks,
  hasLocalConflict,
  ensureGitignore,
  ensurePluginsDir,
} from "./symlinks"
import {
  createPluginSymlinks,
  getRemotePluginSymlinks,
  cleanupStalePluginSymlinks,
  getPluginSymlinkName,
} from "./plugin-symlinks"
import type { PluginInfo } from "./plugin-info"
import { appendFileSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"

/** Prefix for all log messages */
const LOG_PREFIX = "[remote-config]"

/** Log file path */
const LOG_DIR = join(homedir(), ".cache", "opencode", "remote-config")
const LOG_FILE = join(LOG_DIR, "plugin.log")

/** Guard to prevent duplicate initialization within the same process */
let initialized = false

/**
 * Get current timestamp for log entries
 */
function timestamp(): string {
  return new Date().toISOString()
}

/**
 * Write to log file
 */
function writeLog(level: string, message: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_FILE, `${timestamp()} [${level}] ${message}\n`)
  } catch {
    // Ignore log file errors
  }
}

/**
 * Log a message with the plugin prefix
 */
function log(message: string): void {
  const fullMessage = `${LOG_PREFIX} ${message}`
  console.log(fullMessage)
  writeLog("INFO", message)
}

/**
 * Log an error with the plugin prefix
 */
function logError(message: string): void {
  const fullMessage = `${LOG_PREFIX} ${message}`
  console.error(fullMessage)
  writeLog("ERROR", message)
}

/**
 * Sync all configured repositories and create symlinks
 */
/** Collected remote agents for config injection */
interface RemoteAgent {
  config: AgentConfig
  source: string
}

/** Collected remote commands for config injection */
interface RemoteCommand {
  config: CommandConfig
  source: string
}

async function performSync(
  config: RemoteSkillsConfig
): Promise<{
  results: SyncResult[]
  skippedConflicts: string[]
  totalSkills: number
  remoteAgents: Map<string, RemoteAgent>
  remoteCommands: Map<string, RemoteCommand>
  pluginsChanged: boolean
  totalPlugins: number
}> {
  if (config.repositories.length === 0) {
    return { results: [], skippedConflicts: [], totalSkills: 0, remoteAgents: new Map(), remoteCommands: new Map(), pluginsChanged: false, totalPlugins: 0 }
  }

  log(`Syncing ${config.repositories.length} repositories...`)

  // Sync all repositories
  const results = await syncRepositories(config.repositories)

  // Track skills we're creating symlinks for (to clean up stale ones)
  const currentSkills = new Set<string>()
  const skippedConflicts: string[] = []
  let totalSkills = 0

  // Process each repository result
  for (const result of results) {
    if (result.error) {
      logError(`✗ Failed to sync ${result.shortName}: ${result.error}`)
      continue
    }

    // Filter out conflicting skills
    const skillsToLink = result.skills.filter((skill) => {
      if (hasLocalConflict(skill.name)) {
        skippedConflicts.push(skill.name)
        return false
      }
      return true
    })

    // Update result with filtered skills for symlink creation
    const filteredResult = { ...result, skills: skillsToLink }

    // Create symlinks
    const symlinkResults = createSymlinksForRepo(filteredResult)

    // Track which skills we created
    for (const sr of symlinkResults) {
      if (!sr.error) {
        currentSkills.add(`${result.shortName}/${sr.skillName}`)
        totalSkills++
      } else {
        logError(`✗ Failed to create symlink for ${sr.skillName}: ${sr.error}`)
      }
    }

    const skillCount = skillsToLink.length
    const status = result.updated ? "✓" : "✓"
    log(`${status} ${result.shortName} (${result.ref}) - ${skillCount} skills`)
  }

  // Clean up stale symlinks
  const cleanup = cleanupStaleSymlinks(currentSkills)
  if (cleanup.removed.length > 0) {
    log(`Cleaned up ${cleanup.removed.length} stale symlinks`)
  }

  // Log conflicts
  for (const conflict of skippedConflicts) {
    log(`⚠ Conflict: '${conflict}' exists locally, skipping`)
  }

  // Collect agents from all repositories (first repo wins for duplicates)
  const remoteAgents = new Map<string, RemoteAgent>()
  for (const result of results) {
    if (result.error) continue
    
    for (const agent of result.agents) {
      if (remoteAgents.has(agent.name)) {
        const existing = remoteAgents.get(agent.name)!
        log(`⚠ Agent '${agent.name}' already loaded from ${existing.source}, skipping from ${result.shortName}`)
        continue
      }
      
      remoteAgents.set(agent.name, {
        config: agent.config,
        source: result.shortName,
      })
    }
  }

  if (remoteAgents.size > 0) {
    log(`Discovered ${remoteAgents.size} remote agents`)
  }

  // Collect commands from all repositories (first repo wins for duplicates)
  const remoteCommands = new Map<string, RemoteCommand>()
  for (const result of results) {
    if (result.error) continue
    
    for (const command of result.commands) {
      if (remoteCommands.has(command.name)) {
        const existing = remoteCommands.get(command.name)!
        log(`⚠ Command '${command.name}' already loaded from ${existing.source}, skipping from ${result.shortName}`)
        continue
      }
      
      remoteCommands.set(command.name, {
        config: command.config,
        source: result.shortName,
      })
    }
  }

  if (remoteCommands.size > 0) {
    log(`Discovered ${remoteCommands.size} remote commands`)
  }

  // Collect all plugins from repositories
  const allPlugins: PluginInfo[] = []
  for (const result of results) {
    if (result.error) continue
    allPlugins.push(...result.plugins)
  }

  // Get existing plugin symlinks before making changes
  const existingPluginSymlinks = new Set(getRemotePluginSymlinks())
  
  // Create symlinks for all plugins
  const newPluginSymlinks = new Set<string>()
  if (allPlugins.length > 0) {
    const symlinkResults = createPluginSymlinks(allPlugins)
    for (const sr of symlinkResults) {
      if (!sr.error) {
        newPluginSymlinks.add(sr.symlinkName)
      } else {
        logError(`✗ Failed to create plugin symlink for ${sr.pluginName}: ${sr.error}`)
      }
    }
    log(`Discovered ${allPlugins.length} remote plugins`)
  }

  // Clean up stale plugin symlinks
  const pluginCleanup = cleanupStalePluginSymlinks(newPluginSymlinks)
  if (pluginCleanup.removed.length > 0) {
    log(`Cleaned up ${pluginCleanup.removed.length} stale plugin symlinks`)
  }

  // Detect if plugins changed (for restart notification)
  const pluginsChanged = !setsEqual(existingPluginSymlinks, newPluginSymlinks)
  const totalPlugins = newPluginSymlinks.size

  return { results, skippedConflicts, totalSkills, remoteAgents, remoteCommands, pluginsChanged, totalPlugins }
}

/**
 * Check if two sets are equal
 */
function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false
  for (const item of a) {
    if (!b.has(item)) return false
  }
  return true
}

/**
 * OpenCode Remote Skills Plugin
 *
 * Syncs skills from configured Git repositories, making them available
 * to OpenCode agents without polluting the user's skill directory.
 */
export const RemoteSkillsPlugin: Plugin = async (ctx) => {
  // Prevent duplicate initialization within the same process
  if (initialized) {
    return {}
  }
  initialized = true

  // Load configuration from separate file (not opencode.json)
  const pluginConfig = loadConfig()

  if (pluginConfig.repositories.length === 0) {
    // No repositories configured, nothing to do
    return {}
  }

  // Ensure the _plugins directory exists
  ensurePluginsDir()

  // Ensure .gitignore is set up
  const gitignoreResult = await ensureGitignore()
  if (gitignoreResult.modified) {
    log(`Added _plugins/ to .gitignore at ${gitignoreResult.gitRoot}`)
  }

  // Sync repositories and discover agents/commands (blocking - they are needed for config resolution)
  const { totalSkills, skippedConflicts, remoteAgents, remoteCommands, pluginsChanged, totalPlugins } = await performSync(pluginConfig)
  
  // Notify user if plugins changed (requires restart to take effect)
  if (pluginsChanged) {
    log("⚠ Plugin changes detected. Restart OpenCode to apply.")
  }
  
  const skippedCount = skippedConflicts.length
  const parts: string[] = []
  if (totalSkills > 0) parts.push(`${totalSkills} skills`)
  if (totalPlugins > 0) parts.push(`${totalPlugins} plugins`)
  
  let message: string
  if (parts.length === 0) {
    message = "No remote config found"
  } else {
    message = `${parts.join(", ")} available`
    if (skippedCount > 0) {
      message += ` (${skippedCount} skills skipped due to conflicts)`
    }
  }
  log(message)

  return {
    /**
     * Config hook: inject remote agents and commands into config
     * Priority: user config > first repository in config > subsequent repositories
     */
    config: async (config) => {
      // Inject agents
      if (remoteAgents.size > 0) {
        // Ensure config.agent exists and is an object
        if (config.agent !== undefined && (typeof config.agent !== "object" || config.agent === null)) {
          logError("config.agent is not an object, skipping agent injection")
        } else {
          config.agent = config.agent || {}
          
          let injectedAgentCount = 0
          for (const [name, { config: agentConfig }] of remoteAgents) {
            // Skip if user already has this agent defined (use hasOwnProperty to handle
            // falsy values like null correctly - user's explicit null should not be overwritten)
            if (Object.prototype.hasOwnProperty.call(config.agent, name)) {
              continue
            }
            
            // Type cast required: our zod schema validates the shape but uses a more
            // permissive permission type than OpenCode's internal AgentConfig type
            config.agent[name] = agentConfig as unknown as typeof config.agent[string]
            injectedAgentCount++
          }
          
          if (injectedAgentCount > 0) {
            log(`Injected ${injectedAgentCount} remote agents into config`)
          }
        }
      }
      
      // Inject commands
      if (remoteCommands.size > 0) {
        // Ensure config.command exists and is an object
        if (config.command !== undefined && (typeof config.command !== "object" || config.command === null)) {
          logError("config.command is not an object, skipping command injection")
        } else {
          config.command = config.command || {}
          
          let injectedCommandCount = 0
          for (const [name, { config: commandConfig }] of remoteCommands) {
            // Skip if user already has this command defined
            if (Object.prototype.hasOwnProperty.call(config.command, name)) {
              continue
            }
            
            // Type cast required: our zod schema validates the shape but uses a more
            // permissive type than OpenCode's internal Command type
            config.command[name] = commandConfig as unknown as typeof config.command[string]
            injectedCommandCount++
          }
          
          if (injectedCommandCount > 0) {
            log(`Injected ${injectedCommandCount} remote commands into config`)
          }
        }
      }
    },
    
    /**
     * Handle events (for future extension)
     */
    event: async ({ event }) => {
      // Could listen for session.idle to show background sync results
    },
  }
}

export default RemoteSkillsPlugin

// Export types and utilities for external use
export type { RemoteSkillsConfig, RepositoryConfig } from "./config"
export type { SyncResult, SkillInfo, AgentInfo, CommandInfo } from "./git"
export type { AgentConfig } from "./agent"
export type { CommandConfig } from "./command"
