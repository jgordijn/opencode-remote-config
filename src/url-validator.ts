/**
 * Validates git URLs and refs to prevent command-argument injection.
 *
 * Security context: The plugin passes URLs and refs to `git clone`,
 * `git checkout`, etc. via Bun's `$` tagged template. While `$` prevents
 * shell injection, it does NOT prevent git argument injection — a value
 * starting with `-` becomes a git flag. The `--template` flag in
 * particular can cause arbitrary code execution via git hook scripts.
 */

// Tightened patterns per scheme:
// - https/http: require a valid hostname char after ://
// - git@: require valid hostname + colon + alphanumeric/slash start (prevents git@host:-flag)
// - ssh://: require a valid char after :// (prevents ssh://-oProxyCommand=evil)
// - file://: allow (path validation handled separately by fileUrlToPath)
const ALLOWED_URL_SCHEMES =
  /^(https?:\/\/[a-zA-Z0-9]|git@[a-zA-Z0-9][a-zA-Z0-9.-]*:[a-zA-Z0-9_./]|ssh:\/\/[a-zA-Z0-9@]|file:\/\/)/

/**
 * Validate a git repository URL.
 *
 * @throws Error if the URL could be interpreted as a git flag, uses an
 *   unsupported scheme, or contains control characters.
 *
 * Note: `file://` URLs pass this check — path sandboxing is enforced
 * separately by `fileUrlToPath()` in `git.ts`.
 */
export function validateGitUrl(url: string): void {
  if (typeof url !== "string" || url.trim().length === 0) {
    throw new Error("Repository URL must be a non-empty string")
  }

  // Reject control characters that could confuse argument parsing or logging.
  if (/[\r\n\0\t]/.test(url)) {
    throw new Error(
      `Repository URL must not contain control characters: ${JSON.stringify(url)}`,
    )
  }

  if (url.startsWith("-")) {
    throw new Error(
      `Repository URL must not start with '-' (would be interpreted as a git flag): ${url}`,
    )
  }

  if (!ALLOWED_URL_SCHEMES.test(url)) {
    throw new Error(
      `Repository URL must start with https://, http://, git@host:, ssh://, or file:// — got: ${url}`,
    )
  }

  // After scheme validation: ensure the authority/path after :// doesn't
  // start with '-'. This catches ssh://-oProxyCommand=evil and similar
  // patterns where the scheme prefix hides a leading-dash attack.
  const schemeEnd = url.indexOf("://")
  if (schemeEnd !== -1) {
    const afterScheme = url.slice(schemeEnd + 3)
    if (afterScheme.startsWith("-")) {
      throw new Error(
        `Repository URL authority must not start with '-' (would be interpreted as a flag): ${url}`,
      )
    }
  }
}

/**
 * Validate a git ref (branch, tag, or commit SHA).
 *
 * Enforces a strict character allowlist plus a leading-dash guard to
 * prevent argument injection into `git checkout`. This is deliberately
 * stricter than git-check-ref-format(1) — we allow only characters needed
 * for branch names, tag names, and SHAs.
 *
 * Excluded characters and why:
 * - `^`, `~`: git revision operators (HEAD~3, main^2)
 * - `{`, `}`: git revision dereferencing (v1.0^{commit})
 * - `@` followed by `{`: git reflog syntax (HEAD@{1})
 * - `:`: git object-path syntax (HEAD:path/to/file)
 * - `..`, `...`: git range operators (main..feature)
 */
export function validateGitRef(ref: string): void {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new Error("Git ref must be a non-empty string")
  }

  if (ref.startsWith("-")) {
    throw new Error(
      `Git ref must not start with '-' (would be interpreted as a git flag): ${ref}`,
    )
  }

  // Allow alphanumerics, hyphen, underscore, dot, slash, @.
  // Excludes: ^, ~, {, }, : (revision/refspec operators), whitespace, shell metacharacters.
  // Note: the leading-dash check above catches `-foo`; the allowlist here
  // permits internal hyphens (e.g., `feature/my-branch`, `v1.0-rc.1`).
  if (!/^[a-zA-Z0-9._/@-]+$/.test(ref)) {
    throw new Error(`Git ref contains unsafe characters: ${ref}`)
  }

  // Reject git range operators (.. and ...) which are valid in the allowlist
  // because . is permitted for branch names like "v1.2.3".
  if (/\.\./.test(ref)) {
    throw new Error(`Git ref must not contain '..' (range operator): ${ref}`)
  }
}
