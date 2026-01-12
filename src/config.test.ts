import { describe, test, expect } from "bun:test"
import {
  parseConfig,
  getRepoShortName,
  getRepoId,
  getConfigPaths,
  RemoteSkillsConfigSchema,
  RepositoryConfigSchema,
  FilterConfigSchema,
  shouldImport,
} from "./config"
import { join } from "path"
import { homedir } from "os"

describe("config", () => {
  describe("FilterConfigSchema", () => {
    test("accepts include array", () => {
      const result = FilterConfigSchema.safeParse({
        include: ["skill-a", "skill-b"],
      })
      expect(result.success).toBe(true)
    })

    test("accepts exclude array", () => {
      const result = FilterConfigSchema.safeParse({
        exclude: ["skill-c"],
      })
      expect(result.success).toBe(true)
    })

    test("rejects empty include array", () => {
      const result = FilterConfigSchema.safeParse({
        include: [],
      })
      expect(result.success).toBe(false)
    })

    test("rejects empty exclude array", () => {
      const result = FilterConfigSchema.safeParse({
        exclude: [],
      })
      expect(result.success).toBe(false)
    })

    test("rejects both include and exclude", () => {
      const result = FilterConfigSchema.safeParse({
        include: ["a"],
        exclude: ["b"],
      })
      expect(result.success).toBe(false)
    })

    test("rejects unknown keys (strict mode)", () => {
      const result = FilterConfigSchema.safeParse({
        include: ["a"],
        unknown: "value",
      })
      expect(result.success).toBe(false)
    })
  })

  describe("shouldImport", () => {
    test("returns true when config is undefined", () => {
      expect(shouldImport("any-skill", undefined)).toBe(true)
    })

    test("returns true when config is '*'", () => {
      expect(shouldImport("any-skill", "*")).toBe(true)
    })

    test("returns true when name is in include list", () => {
      expect(shouldImport("skill-a", { include: ["skill-a", "skill-b"] })).toBe(true)
    })

    test("returns false when name is not in include list", () => {
      expect(shouldImport("skill-c", { include: ["skill-a", "skill-b"] })).toBe(false)
    })

    test("returns true when name is not in exclude list", () => {
      expect(shouldImport("skill-a", { exclude: ["skill-c"] })).toBe(true)
    })

    test("returns false when name is in exclude list", () => {
      expect(shouldImport("skill-c", { exclude: ["skill-c", "skill-d"] })).toBe(false)
    })
  })

  describe("RepositoryConfigSchema", () => {
    test("validates minimal config", () => {
      const result = RepositoryConfigSchema.safeParse({
        url: "git@github.com:org/repo.git",
      })
      expect(result.success).toBe(true)
    })

    test("validates config with include filter", () => {
      const result = RepositoryConfigSchema.safeParse({
        url: "git@github.com:org/repo.git",
        ref: "main",
        skills: { include: ["skill-a", "skill-b"] },
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.skills).toEqual({ include: ["skill-a", "skill-b"] })
      }
    })

    test("validates config with exclude filter", () => {
      const result = RepositoryConfigSchema.safeParse({
        url: "git@github.com:org/repo.git",
        agents: { exclude: ["internal-agent"] },
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.agents).toEqual({ exclude: ["internal-agent"] })
      }
    })

    test("accepts * for all skills", () => {
      const result = RepositoryConfigSchema.safeParse({
        url: "git@github.com:org/repo.git",
        skills: "*",
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.skills).toBe("*")
      }
    })

    test("rejects empty url", () => {
      const result = RepositoryConfigSchema.safeParse({
        url: "",
      })
      expect(result.success).toBe(false)
    })

    test("rejects unknown keys (strict mode)", () => {
      const result = RepositoryConfigSchema.safeParse({
        url: "git@github.com:org/repo.git",
        unknownKey: "should fail",
      })
      expect(result.success).toBe(false)
    })

    test("rejects old array syntax (backward incompatible)", () => {
      const result = RepositoryConfigSchema.safeParse({
        url: "git@github.com:org/repo.git",
        skills: ["skill-a", "skill-b"],
      })
      expect(result.success).toBe(false)
    })
  })

  describe("RemoteSkillsConfigSchema", () => {
    test("returns defaults for empty config", () => {
      const result = RemoteSkillsConfigSchema.safeParse({})
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.repositories).toEqual([])
        expect(result.data.sync).toBe("blocking")
        expect(result.data.installMethod).toBe("link")
      }
    })

    test("validates sync modes", () => {
      expect(RemoteSkillsConfigSchema.safeParse({ sync: "blocking" }).success).toBe(true)
      expect(RemoteSkillsConfigSchema.safeParse({ sync: "background" }).success).toBe(true)
      expect(RemoteSkillsConfigSchema.safeParse({ sync: "invalid" }).success).toBe(false)
    })

    test("validates installMethod modes", () => {
      expect(RemoteSkillsConfigSchema.safeParse({ installMethod: "link" }).success).toBe(true)
      expect(RemoteSkillsConfigSchema.safeParse({ installMethod: "copy" }).success).toBe(true)
      expect(RemoteSkillsConfigSchema.safeParse({ installMethod: "invalid" }).success).toBe(false)
    })

    test("accepts $schema key for editor support", () => {
      const result = RemoteSkillsConfigSchema.safeParse({
        $schema: "https://example.com/schema.json",
        repositories: [],
      })
      expect(result.success).toBe(true)
    })

    test("rejects unknown keys (strict mode)", () => {
      const result = RemoteSkillsConfigSchema.safeParse({
        repositories: [],
        unknownKey: "should fail",
      })
      expect(result.success).toBe(false)
    })
  })

  describe("getConfigPaths", () => {
    test("returns project and global paths", () => {
      const paths = getConfigPaths()
      expect(paths).toHaveLength(2)
      expect(paths[0]).toBe(join(process.cwd(), ".opencode", "remote-config.json"))
      expect(paths[1]).toBe(join(homedir(), ".config", "opencode", "remote-config.json"))
    })
  })

  describe("parseConfig", () => {
    test("returns defaults for null/undefined", () => {
      expect(parseConfig(null)).toEqual({ repositories: [], sync: "blocking", installMethod: "link" })
      expect(parseConfig(undefined)).toEqual({ repositories: [], sync: "blocking", installMethod: "link" })
    })

    test("returns defaults for non-object", () => {
      expect(parseConfig("string")).toEqual({ repositories: [], sync: "blocking", installMethod: "link" })
      expect(parseConfig(123)).toEqual({ repositories: [], sync: "blocking", installMethod: "link" })
    })

    test("returns defaults for empty object", () => {
      const result = parseConfig({})
      expect(result.repositories).toEqual([])
      expect(result.sync).toBe("blocking")
      expect(result.installMethod).toBe("link")
    })

    test("parses valid config directly (no wrapper key)", () => {
      const config = {
        repositories: [{ url: "git@github.com:org/repo.git" }],
        sync: "background",
      }
      const result = parseConfig(config)
      expect(result.repositories).toHaveLength(1)
      expect(result.sync).toBe("background")
    })

    describe("installMethod", () => {
      test("defaults to 'link' when not specified", () => {
        const config = parseConfig({
          repositories: [],
        })
        expect(config.installMethod).toBe("link")
      })

      test("accepts 'link' value", () => {
        const config = parseConfig({
          installMethod: "link",
          repositories: [],
        })
        expect(config.installMethod).toBe("link")
      })

      test("accepts 'copy' value", () => {
        const config = parseConfig({
          installMethod: "copy",
          repositories: [],
        })
        expect(config.installMethod).toBe("copy")
      })

      test("rejects invalid installMethod values", () => {
        // This should fall back to default config due to validation error
        const config = parseConfig({
          installMethod: "invalid",
          repositories: [],
        })
        // parseConfig returns DEFAULT_CONFIG on validation failure
        expect(config.installMethod).toBe("link")
      })
    })
  })

  describe("getRepoShortName", () => {
    test("extracts name from SSH URL", () => {
      expect(getRepoShortName("git@github.com:company/shared-skills.git")).toBe("shared-skills")
    })

    test("extracts name from HTTPS URL", () => {
      expect(getRepoShortName("https://github.com/team/my-repo.git")).toBe("my-repo")
    })

    test("handles URL without .git suffix", () => {
      expect(getRepoShortName("https://github.com/org/repo")).toBe("repo")
    })

    test("extracts name from file:// URL", () => {
      expect(getRepoShortName("file:///path/to/my-skills")).toBe("my-skills")
    })

    test("extracts name from file:// URL with trailing slash", () => {
      expect(getRepoShortName("file:///path/to/skills/")).toBe("skills")
    })
  })

  describe("getRepoId", () => {
    test("generates ID from SSH URL", () => {
      expect(getRepoId("git@github.com:company/shared-skills.git")).toBe(
        "github.com-company-shared-skills"
      )
    })

    test("generates ID from HTTPS URL", () => {
      expect(getRepoId("https://github.com/team/my-repo.git")).toBe(
        "github.com-team-my-repo"
      )
    })

    test("handles nested paths", () => {
      expect(getRepoId("git@gitlab.com:org/group/project.git")).toBe(
        "gitlab.com-org-group-project"
      )
    })

    test("generates ID from file:// URL", () => {
      expect(getRepoId("file:///path/to/skills")).toBe(
        "local--path-to-skills"
      )
    })

    test("prefixes file:// IDs with 'local-'", () => {
      const id = getRepoId("file:///some/path")
      expect(id.startsWith("local-")).toBe(true)
    })
  })
})
