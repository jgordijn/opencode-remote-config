import { z } from "zod"
import { existsSync, readFileSync } from "fs"
import { join, isAbsolute } from "path"

/** Manifest file name */
const MANIFEST_FILENAME = "manifest.json"

/**
 * Checks if a path contains traversal or self-reference segments ("." or "..").
 * Splits on "/" and checks for "." or ".." as standalone segments.
 */
function containsPathTraversal(path: string): boolean {
  return path.split("/").some((segment) => segment === ".." || segment === ".")
}

/**
 * Validates that a path is a safe relative markdown file.
 * - Must not be empty
 * - Must end with .md and have a filename before the extension
 * - Must be a relative POSIX-style path (no absolute paths, no backslashes)
 * - Must not contain path traversal segments (..)
 * - Must not contain consecutive slashes or trailing slashes
 * - Paths starting with "./" are normalized by stripping the prefix
 */
const instructionPathSchema = z.string()
  .transform((path) => path.trim())
  .transform((path) => path.startsWith("./") ? path.slice(2) : path)
  .refine(
    (path) => path.length > 0,
    { message: "Instruction path must not be empty" }
  )
  .refine(
    (path) => path.endsWith(".md"),
    { message: "Instruction path must end with .md" }
  )
  .refine(
    (path) => {
      // Extract the filename (last segment after the last slash, or the whole path)
      const filename = path.includes("/") ? path.split("/").pop()! : path
      // Must have at least one character before ".md"
      return filename.length > 3
    },
    { message: "Instruction path must have a filename before .md extension" }
  )
  .refine(
    (path) => !isAbsolute(path),
    { message: "Instruction path must be relative (absolute paths not allowed)" }
  )
  .refine(
    (path) => !path.includes("\\"),
    { message: "Instruction path must use forward slashes (POSIX-style)" }
  )
  .refine(
    (path) => !containsPathTraversal(path),
    { message: "Instruction path must not contain path traversal (. or ..)" }
  )
  .refine(
    (path) => !path.includes("//"),
    { message: "Instruction path must not contain consecutive slashes" }
  )
  .refine(
    (path) => !path.endsWith("/"),
    { message: "Instruction path must not have a trailing slash" }
  )

/**
 * Schema for the manifest.json file in skill repositories.
 * Used to define repository-wide instructions that apply to all skills.
 */
export const ManifestSchema = z.object({
  /** Optional JSON Schema reference for editor support */
  $schema: z.string().optional(),

  /**
   * Array of markdown files to include as repository-wide instructions.
   * Paths are relative to the repository root and must end with .md.
   */
  instructions: z.array(instructionPathSchema).optional().default([]),
})

export type Manifest = z.infer<typeof ManifestSchema>

/**
 * Load and parse the manifest.json file from a repository.
 * 
 * Uses synchronous file operations because this runs at plugin load time
 * with a small number of repositories, where blocking is acceptable.
 * 
 * @param repoPath - The path to the repository root
 * @returns The parsed manifest, or null if the file doesn't exist or is invalid
 */
export function loadManifest(repoPath: string): Manifest | null {
  const manifestPath = join(repoPath, MANIFEST_FILENAME)

  if (!existsSync(manifestPath)) {
    return null
  }

  try {
    const content = readFileSync(manifestPath, "utf-8")
    const parsed = JSON.parse(content)
    const result = ManifestSchema.safeParse(parsed)

    if (!result.success) {
      console.warn(
        `[remote-config] Invalid manifest.json in ${repoPath}:`,
        result.error.format()
      )
      return null
    }

    return result.data
  } catch (error) {
    console.warn(`[remote-config] Error reading manifest.json in ${repoPath}:`, error)
    return null
  }
}
