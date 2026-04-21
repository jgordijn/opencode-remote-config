import { z } from "zod"

/**
 * Permission action: what to do when a permission is requested
 */
const PermissionAction = z.enum(["ask", "allow", "deny"])

/**
 * Permission rule: either a simple action or a record of patterns to actions
 * Examples:
 * - Simple: "allow"
 * - Pattern-based: { "*": "deny", "*.md": "allow" }
 */
const PermissionRule = z.union([
  PermissionAction,
  z.record(z.string(), PermissionAction)
])

/**
 * Permission configuration matching OpenCode's schema
 * Can be a simple action or a record of tool names to rules
 */
const Permission = z.record(z.string(), PermissionRule)
  .or(PermissionAction)

/**
 * Agent configuration schema matching OpenCode's Config.Agent
 * See: packages/opencode/src/config/config.ts
 */
export const AgentConfigSchema = z.object({
  /** Model to use in format provider/model-id */
  model: z.string().optional(),
  /** Temperature for LLM (0.0-2.0, typically 0.0-1.0) */
  temperature: z.number().min(0).max(2).optional(),
  /** Top-p sampling parameter (0.0-1.0) */
  top_p: z.number().min(0).max(1).optional(),
  /** System prompt for the agent */
  prompt: z.string().optional(),
  /** Legacy tool enable/disable configuration */
  tools: z.record(z.string(), z.boolean()).optional(),
  /** Disable this agent */
  disable: z.boolean().optional(),
  /** Description of when to use the agent */
  description: z.string().optional(),
  /** Agent mode: subagent, primary, or all */
  mode: z.enum(["subagent", "primary", "all"]).optional(),
  /** Additional options passed to the agent — keys and values must be strings */
  options: z.record(z.string(), z.string()).optional(),
  /** Hex color code for the agent (e.g., #FF5733) */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  /** Maximum number of agentic iterations */
  steps: z.number().int().positive().optional(),
  /** Legacy maximum steps configuration */
  maxSteps: z.number().int().positive().optional(),
  /** Permission configuration for tools */
  permission: Permission.optional(),
}).strict()  // Reject unknown keys — prevents config injection from malicious repos

export type AgentConfig = z.infer<typeof AgentConfigSchema>

/**
 * Information about an agent discovered in a repository
 */
export interface AgentInfo {
  /** Agent name (derived from file path) */
  name: string
  /** Full path to the agent markdown file */
  path: string
  /** Parsed and validated agent configuration */
  config: AgentConfig
}
