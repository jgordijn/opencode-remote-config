import { describe, test, expect } from "bun:test"
import { AgentConfigSchema } from "./agent"

describe("AgentConfigSchema", () => {
  describe("basic validation", () => {
    test("validates minimal agent config", () => {
      const config = {
        description: "Test agent",
      }
      const result = AgentConfigSchema.safeParse(config)
      expect(result.success).toBe(true)
    })

    test("validates agent config with all standard fields", () => {
      const config = {
        description: "Comprehensive test agent",
        model: "anthropic/claude-3-5-sonnet",
        mode: "subagent",
        temperature: 0.7,
        top_p: 0.9,
        prompt: "You are a test agent",
        color: "#FF5733",
        steps: 10,
        maxSteps: 20,
        disable: false,
        tools: { bash: true, edit: false },
      }
      const result = AgentConfigSchema.safeParse(config)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.description).toBe("Comprehensive test agent")
        expect(result.data.model).toBe("anthropic/claude-3-5-sonnet")
        expect(result.data.mode).toBe("subagent")
        expect(result.data.temperature).toBe(0.7)
      }
    })

    test("allows empty config (all fields optional)", () => {
      const result = AgentConfigSchema.safeParse({})
      expect(result.success).toBe(true)
    })

    test("rejects unknown fields (strict mode — prevents config injection)", () => {
      const config = {
        description: "Test",
        customField: "custom value",
        anotherCustom: 123,
      }
      const result = AgentConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })
  })

  describe("mode validation", () => {
    test("accepts valid mode values", () => {
      const modes = ["subagent", "primary", "all"] as const
      for (const mode of modes) {
        const result = AgentConfigSchema.safeParse({ mode })
        expect(result.success).toBe(true)
      }
    })

    test("rejects invalid mode value", () => {
      const result = AgentConfigSchema.safeParse({ mode: "invalid" })
      expect(result.success).toBe(false)
    })
  })

  describe("color validation", () => {
    test("accepts valid hex color", () => {
      const validColors = ["#FF5733", "#000000", "#FFFFFF", "#abc123"]
      for (const color of validColors) {
        const result = AgentConfigSchema.safeParse({ color })
        expect(result.success).toBe(true)
      }
    })

    test("rejects invalid color formats", () => {
      const invalidColors = [
        "red",           // Named color
        "#FFF",          // 3-digit hex
        "#FFFFFFF",      // 7 digits
        "FF5733",        // Missing hash
        "#GG5733",       // Invalid hex character
      ]
      for (const color of invalidColors) {
        const result = AgentConfigSchema.safeParse({ color })
        expect(result.success).toBe(false)
      }
    })
  })

  describe("numeric field validation", () => {
    test("rejects non-numeric temperature", () => {
      const result = AgentConfigSchema.safeParse({ temperature: "hot" })
      expect(result.success).toBe(false)
    })

    test("rejects temperature outside bounds (0-2)", () => {
      expect(AgentConfigSchema.safeParse({ temperature: -0.1 }).success).toBe(false)
      expect(AgentConfigSchema.safeParse({ temperature: 2.1 }).success).toBe(false)
      // Edge cases that should pass
      expect(AgentConfigSchema.safeParse({ temperature: 0 }).success).toBe(true)
      expect(AgentConfigSchema.safeParse({ temperature: 2 }).success).toBe(true)
    })

    test("rejects top_p outside bounds (0-1)", () => {
      expect(AgentConfigSchema.safeParse({ top_p: -0.1 }).success).toBe(false)
      expect(AgentConfigSchema.safeParse({ top_p: 1.1 }).success).toBe(false)
      // Edge cases that should pass
      expect(AgentConfigSchema.safeParse({ top_p: 0 }).success).toBe(true)
      expect(AgentConfigSchema.safeParse({ top_p: 1 }).success).toBe(true)
    })

    test("rejects non-integer steps", () => {
      const result = AgentConfigSchema.safeParse({ steps: 5.5 })
      expect(result.success).toBe(false)
    })

    test("rejects non-positive steps", () => {
      const result = AgentConfigSchema.safeParse({ steps: 0 })
      expect(result.success).toBe(false)
      
      const result2 = AgentConfigSchema.safeParse({ steps: -1 })
      expect(result2.success).toBe(false)
    })

    test("accepts valid numeric values", () => {
      const result = AgentConfigSchema.safeParse({
        temperature: 0.5,
        top_p: 0.95,
        steps: 15,
        maxSteps: 100,
      })
      expect(result.success).toBe(true)
    })
  })

  describe("permission validation", () => {
    test("accepts simple permission action", () => {
      const permissions = ["ask", "allow", "deny"] as const
      for (const permission of permissions) {
        const result = AgentConfigSchema.safeParse({ permission })
        expect(result.success).toBe(true)
      }
    })

    test("accepts permission object with tool rules", () => {
      const config = {
        permission: {
          edit: "deny",
          bash: "ask",
          webfetch: "allow",
        },
      }
      const result = AgentConfigSchema.safeParse(config)
      expect(result.success).toBe(true)
    })

    test("accepts mixed permission with pattern rules", () => {
      const config = {
        permission: {
          edit: "allow",
          bash: {
            "*": "deny",
            "npm *": "allow",
            "git *": "allow",
          },
        },
      }
      const result = AgentConfigSchema.safeParse(config)
      expect(result.success).toBe(true)
    })

    test("rejects invalid permission action", () => {
      const result = AgentConfigSchema.safeParse({
        permission: "invalid-action",
      })
      expect(result.success).toBe(false)
    })
  })

  describe("tools validation", () => {
    test("accepts valid tools configuration", () => {
      const config = {
        tools: {
          bash: true,
          edit: false,
          webfetch: true,
        },
      }
      const result = AgentConfigSchema.safeParse(config)
      expect(result.success).toBe(true)
    })

    test("rejects non-boolean tool values", () => {
      const result = AgentConfigSchema.safeParse({
        tools: {
          bash: "enabled",
        },
      })
      expect(result.success).toBe(false)
    })
  })

  describe("prompt handling", () => {
    test("accepts string prompt", () => {
      const config = {
        prompt: "You are a helpful assistant.",
      }
      const result = AgentConfigSchema.safeParse(config)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.prompt).toBe("You are a helpful assistant.")
      }
    })

    test("accepts multiline prompt", () => {
      const config = {
        prompt: `You are an expert developer.
You write clean, maintainable code.
You follow best practices.`,
      }
      const result = AgentConfigSchema.safeParse(config)
      expect(result.success).toBe(true)
    })

    test("accepts empty string prompt", () => {
      const result = AgentConfigSchema.safeParse({ prompt: "" })
      expect(result.success).toBe(true)
    })
  })

  describe("strict mode — rejects unknown fields", () => {
    test("rejects unknown top-level fields", () => {
      const result = AgentConfigSchema.safeParse({
        description: "hi",
        mode: "subagent",
        evil_field: "nope",
      })
      expect(result.success).toBe(false)
    })

    test("accepts all documented fields", () => {
      const result = AgentConfigSchema.safeParse({
        description: "a",
        mode: "subagent",
        model: "anthropic/claude-3-5-sonnet",
        temperature: 0.7,
        top_p: 0.9,
        color: "#FF5733",
        tools: { bash: true, edit: false },
        disable: false,
      })
      expect(result.success).toBe(true)
    })
  })
})
