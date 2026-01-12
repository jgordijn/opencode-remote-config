# opencode-remote-config

An OpenCode plugin that syncs skills and agents from Git repositories, making them available to OpenCode without polluting your local configuration.

## Features

- **Git-based sync**: Clone once, fetch updates on startup
- **Local directories**: Use `file://` URLs for local directories (great for development)
- **Skills import**: Import skill definitions from `skill/` directory
- **Agents import**: Import agent definitions from `agent/` directory
- **Plugins import**: Import OpenCode hook plugins from `plugin/` directory
- **Selective import**: Import all or specify which skills/agents/plugins to include
- **Ref pinning**: Pin to branch, tag, or commit SHA
- **Priority handling**: User config > first repository > subsequent repositories
- **Conflict handling**: Local definitions take precedence, warns on conflicts
- **Gitignore management**: Automatically adds `_plugins/` to `.gitignore`

---

## For Humans

### Installation

#### Option 1: npm (Recommended)

```bash
# Global installation
npm install -g @jgordijn/opencode-remote-config

# Or with bun
bun add -g @jgordijn/opencode-remote-config
```

Then add the plugin to your OpenCode config (`~/.config/opencode/opencode.json` or `.opencode/opencode.json`):

```json
{
  "plugins": ["@jgordijn/opencode-remote-config"]
}
```

#### Option 2: Git clone

For development or to get the latest changes:

```bash
# Global installation
mkdir -p ~/.config/opencode/plugin
cd ~/.config/opencode/plugin
git clone https://github.com/jgordijn/opencode-remote-config.git
cd opencode-remote-config
bun install && bun run build
```

Or for a project-specific installation:
```bash
mkdir -p .opencode/plugin
cd .opencode/plugin
git clone https://github.com/jgordijn/opencode-remote-config.git
cd opencode-remote-config
bun install && bun run build
```

### Configuration

**Create the configuration file** (`~/.config/opencode/remote-config.json` or `.opencode/remote-config.json`):

   ```jsonc
   {
     "repositories": [
       {
         "url": "git@github.com:company/shared-skills.git",
         "ref": "main",
         "skills": ["code-review", "kotlin-pro"],
         "agents": ["code-reviewer", "specialized/db-expert"],
         "plugins": ["notify", "utils-logger"]
       },
       {
         "url": "git@github.com:team/team-skills.git",
         "ref": "v1.2.0"
       }
     ]
   }
   ```

3. **Restart OpenCode** to load the plugin.

### Configuration

The plugin reads its configuration from a separate JSON file (not `opencode.json`):

| Location | Description |
|----------|-------------|
| `.opencode/remote-config.json` | Project-level config (checked first) |
| `~/.config/opencode/remote-config.json` | Global config (fallback) |

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `repositories` | Array | `[]` | List of repositories to sync |
| `repositories[].url` | String | Required | Git URL, HTTPS URL, or `file://` path |
| `repositories[].ref` | String | Default branch | Branch, tag, or commit SHA (git only) |
| `repositories[].skills` | Array or `"*"` | All skills | Specific skills to import |
| `repositories[].agents` | Array or `"*"` | All agents | Specific agents to import |
| `repositories[].plugins` | Array or `"*"` | All plugins | Specific plugins to import |

### Local Directories

For development or local skill repositories, use `file://` URLs:

```jsonc
{
  "repositories": [
    {
      "url": "file:///path/to/my/local-skills"
    }
  ]
}
```

**Benefits of `file://` URLs:**
- No cloning or caching - symlinks directly to the source directory
- Changes are immediately visible (great for development)
- Works with any local directory containing `skill/`, `agent/`, or `plugin/` folders

### How It Works

Skills are cloned to a cache directory and symlinked into the OpenCode skill directory:

```
~/.cache/opencode/remote-config/repos/
└── github.com-company-shared-skills/
    └── <full git clone>

~/.config/opencode/skill/
├── _plugins/                          # Plugin-managed (auto-gitignored)
│   └── shared-skills/
│       └── code-review -> ~/.cache/.../skill/code-review/
└── my-local-skill/                    # Your own skills (not touched)
    └── SKILL.md
```

**Key points:**
- Your local skills in `~/.config/opencode/skill/` are never modified
- Imported skills go into `_plugins/` subdirectory
- `_plugins/` is automatically added to `.gitignore`
- Local skills always take precedence over imported ones with the same name

### Agents

Agents are discovered from `agent/` or `agents/` directories in repositories. Each agent is defined in a markdown file with YAML frontmatter:

```markdown
---
description: A specialized code reviewer agent
mode: subagent
model: anthropic/claude-3-5-sonnet
temperature: 0.7
---

You are an expert code reviewer. Focus on...
```

Agent names are derived from the file path:
- `agent/code-reviewer.md` -> `code-reviewer`
- `agent/specialized/db-expert.md` -> `specialized/db-expert`

Agents are injected into OpenCode's config via the `config` hook with this priority:
1. **User's local config** - highest priority (defined in `opencode.json`)
2. **First repository** - first repo in the config list wins
3. **Subsequent repositories** - logged and skipped if name conflicts

### Plugins

Plugins are OpenCode hook files (`.ts` or `.js`) discovered from `plugin/` or `plugins/` directories. They are symlinked to `~/.config/opencode/plugin/` using a flat naming convention.

**Discovery rules:**
- Scans `plugin/` directory first; falls back to `plugins/` if `plugin/` doesn't exist
- Recursively discovers `.ts` and `.js` files (case-insensitive extensions)
- Skips hidden files/directories (starting with `.`)
- Maximum depth: 10 levels
- Maximum file size: 256KB

**Plugin requirements:**
- Files must be **self-contained** (no local imports like `./utils` or `../helpers`)
- Must export a valid OpenCode plugin hook
- Must have `.ts` or `.js` extension

**Symlink naming:**
All remote plugins are symlinked with the `_remote_` prefix to distinguish them from local plugins:
- `plugin/notify.ts` in repo `my-hooks` → `_remote_my-hooks_notify.ts`
- `plugin/utils/logger.ts` in repo `shared` → `_remote_shared_utils-logger.ts`

Nested paths are converted to dashes: `plugin/foo/bar/baz.ts` becomes `foo-bar-baz`.

**Name collision handling:** If two repos have plugins that result in the same symlink name, the first repository in your config wins. Subsequent duplicates are logged and skipped.

**Why self-contained?** OpenCode loads plugins as individual files. If your plugin imports `./helper.ts`, that file won't be symlinked and the import will fail. Bundle your dependencies or use npm packages instead.

**Plugin changes require restart:** Unlike skills, plugins are loaded at OpenCode startup. When plugin changes are detected, you'll see:
```
[remote-config] Plugin changes detected. Restart OpenCode to apply.
```

### Example Output

```
[remote-config] Syncing 2 repositories...
[remote-config] ✓ company/shared-skills (main) - 5 skills
[remote-config] ✓ team/team-skills (v1.2.0) - 3 skills
[remote-config] ⚠ Conflict: 'git-commit' exists locally, skipping
[remote-config] Discovered 4 remote agents
[remote-config] Discovered 2 remote plugins
[remote-config] 7 skills, 2 plugins available
[remote-config] Injected 4 remote agents into config
```

### Authentication

The plugin uses your system's Git configuration for authentication:
- **SSH keys**: Ensure your SSH key is configured for the repository host
- **HTTPS**: Use credential helpers or tokens configured in Git

### Requirements

- OpenCode v1.0.0 or later
- Bun runtime (used by OpenCode)
- Git installed and accessible in PATH

---

## For OpenCode (LLM Agents)

This section contains instructions for LLM agents helping users set up the opencode-remote-config plugin.

### Installation Steps

1. **Check if the user has OpenCode installed:**
   ```bash
   opencode --version
   ```

2. **Install the plugin via npm:**
   
   ```bash
   npm install -g @jgordijn/opencode-remote-config
   ```
   
   Then add to OpenCode config (`~/.config/opencode/opencode.json`):
   ```json
   {
     "plugins": ["@jgordijn/opencode-remote-config"]
   }
   ```

   **Alternative: Git clone installation**
   ```bash
   mkdir -p ~/.config/opencode/plugin
   cd ~/.config/opencode/plugin
   git clone https://github.com/jgordijn/opencode-remote-config.git
   cd opencode-remote-config
   bun install && bun run build
   ```

3. **Create the configuration file:**
    
    Create `~/.config/opencode/remote-config.json`:
    ```jsonc
    {
      "repositories": [
        {
          "url": "<git-url-from-user>",
          "ref": "<branch-or-tag-optional>"
        }
      ]
    }
    ```

4. **Verify authentication:**
   
   Test that the user can clone the repository:
   ```bash
   git ls-remote <git-url>
   ```
   
   If this fails, help them set up SSH keys or HTTPS credentials.

5. **Restart OpenCode:**
   
   The plugin will sync on next startup. Instruct the user to restart OpenCode.

### Troubleshooting Guide

**Problem: "Failed to clone" error**
- Check Git authentication (SSH keys, tokens)
- Verify the URL is correct
- Ensure the user has access to the repository

**Problem: Skills not appearing**
- Verify the repository has a `skill/` directory with `SKILL.md` files
- Check if there's a naming conflict with local skills
- Look for warnings in the startup output

**Problem: Updates not reflected**
- In background mode, restart OpenCode to apply updates
- Check that the `ref` (branch/tag) is correct
- Try removing the cached repo: `rm -rf ~/.cache/opencode/remote-config/repos/<repo-id>`

### Repository Structure Requirements

For a repository to provide skills, agents, and/or plugins, use this structure:

```
<repo-root>/
├── skill/                          # Skills directory
│   ├── code-review/
│   │   └── SKILL.md
│   └── testing/
│       └── SKILL.md
├── agent/                          # Agents directory
│   ├── code-reviewer.md
│   └── specialized/
│       └── db-expert.md
└── plugin/                         # Plugins directory
    ├── notify.ts
    └── utils/
        └── logger.ts
```

**Skill format** - Each `SKILL.md` must have YAML frontmatter:
```yaml
---
name: skill-name
description: Brief description of what this skill does
---

# Skill Content

Instructions and content for the skill...
```

**Agent format** - Each agent markdown file has YAML frontmatter:
```yaml
---
description: When to use this agent
mode: subagent           # subagent | primary | all
model: anthropic/claude-3-5-sonnet
temperature: 0.7
color: "#FF5733"
---

You are an expert assistant. Your role is to...
```

Available agent configuration fields:
- `description` - When to use this agent (shown in agent list)
- `mode` - Agent mode: `subagent`, `primary`, or `all`
- `model` - Model to use (e.g., `anthropic/claude-3-5-sonnet`)
- `temperature`, `top_p` - Sampling parameters
- `color` - Hex color code (e.g., `#FF5733`)
- `steps`, `maxSteps` - Maximum agentic iterations
- `tools` - Tool enable/disable map (e.g., `{ bash: true, edit: false }`)
- `permission` - Permission rules for tools
- `disable` - Disable the agent

**Plugin format** - Each plugin file must be a self-contained TypeScript or JavaScript file:
```typescript
// plugin/notify.ts
import type { Plugin } from "@opencode-ai/plugin"

export const NotifyPlugin: Plugin = async (ctx) => {
  return {
    event: async ({ event }) => {
      if (event.type === "session.completed") {
        // Send notification...
      }
    }
  }
}

export default NotifyPlugin
```

**Important:** Plugins must be self-contained. Do NOT use local imports:
```typescript
// ❌ BAD - local import will fail
import { helper } from "./utils/helper"

// ✅ GOOD - npm package imports work
import { z } from "zod"

// ✅ GOOD - Node.js built-ins work
import * as fs from "fs"
```

### Example Configurations

**Single repository, all skills and agents:**
```jsonc
{
  "repositories": [
    { "url": "git@github.com:company/skills.git" }
  ]
}
```

**Multiple repositories, selective import:**
```jsonc
{
  "repositories": [
    {
      "url": "git@github.com:company/shared-skills.git",
      "ref": "main",
      "skills": ["code-review", "testing"],
      "agents": ["code-reviewer"]
    },
    {
      "url": "git@github.com:team/team-skills.git",
      "ref": "v2.0.0",
      "agents": "*"  // Import all agents from this repo
    }
  ]
}
```

**Skills only (no agents):**
```jsonc
{
  "repositories": [
    {
      "url": "git@github.com:company/skills.git",
      "agents": []  // Empty array imports no agents
    }
  ]
}
```

**With plugins:**
```jsonc
{
  "repositories": [
    {
      "url": "git@github.com:company/shared-skills.git",
      "skills": "*",
      "agents": ["code-reviewer"],
      "plugins": ["notify", "analytics"]
    }
  ]
}
```

### Uninstalling

To cleanly remove imported skills, agents, and plugins:

1. **Remove repositories from config** - Set `repositories` to empty array or remove the file:
   ```jsonc
   {
     "repositories": []
   }
   ```

2. **Restart OpenCode** - This triggers cleanup of stale symlinks

3. **Remove the plugin** (optional):
   
   If installed via npm:
   ```bash
   npm uninstall -g @jgordijn/opencode-remote-config
   ```
   
   Then remove from `opencode.json`:
   ```json
   {
     "plugins": []
   }
   ```
   
   If installed via git clone (global):
   ```bash
   rm -rf ~/.config/opencode/plugin/opencode-remote-config
   ```
   
   If installed via git clone (project-local):
   ```bash
   rm -rf .opencode/plugin/opencode-remote-config
   ```

**Important:** Always empty the config and restart OpenCode first before removing the plugin. This ensures all symlinks are properly cleaned up.

**If you skip this step,** orphaned symlinks may remain:
- Skills: `~/.config/opencode/skill/_plugins/<repo-name>/`
- Plugins: `~/.config/opencode/plugin/_remote_*`

To manually clean up orphaned symlinks:
```bash
# Remove skill symlinks
rm -rf ~/.config/opencode/skill/_plugins

# Remove remote plugin symlinks
rm ~/.config/opencode/plugin/_remote_*
```

---

## Development

### Building

```bash
bun install
bun run build
```

### Testing

```bash
bun test
```

### Local Development

The plugin is loaded from the `plugin/` directory:

```bash
# Build and the plugin will be available in ~/.config/opencode/plugin/opencode-remote-config/
bun run build
```

---

## License

MIT
