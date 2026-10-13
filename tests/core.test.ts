import { describe, expect, it } from "vitest"
import {
  type Connection,
  buildRefDescriptor,
  buildRemoteCommand,
  decide,
  extractMentions,
  isHostInSshConfig,
  isManagedSocketFile,
  namespaceOf,
  refPathFor,
  shellQuote,
  socketPathFor,
  stripTargetMentions,
} from "../src/core"

const conn = (server: string, namespace: string): Connection => ({
  host: server,
  socketPath: `/home/u/.ssh/opencode_deadbeef_${server}`,
  serverName: server,
  namespace,
})

const NS_A = "/projects/a"
const NS_B = "/projects/b"

describe("extractMentions", () => {
  it("extracts a simple mention", () => {
    expect(extractMentions("run ls on @web1")).toEqual(["web1"])
  })

  it("deduplicates mentions", () => {
    expect(extractMentions("@web1 a @web1 b")).toEqual(["web1"])
  })

  it("extracts multiple mentions", () => {
    expect(extractMentions("@web1 and @web2")).toEqual(["web1", "web2"])
  })

  it("strips trailing punctuation", () => {
    expect(extractMentions("ping @web1, then done")).toEqual(["web1"])
    expect(extractMentions("(@web1)")).toEqual(["web1"])
  })

  it("does not treat an email local-part as a mention", () => {
    expect(extractMentions("mail me at bob@example.com")).toEqual([])
  })

  it("does not match a bare @", () => {
    expect(extractMentions("at@")).toEqual([])
  })
})

describe("namespaceOf", () => {
  it("prefers workspaceID", () => {
    expect(namespaceOf({ workspaceID: "wrk_1", directory: "/a" })).toBe("wrk_1")
  })

  it("falls back to directory", () => {
    expect(namespaceOf({ directory: "/a" })).toBe("/a")
  })

  it("treats null workspaceID as absent", () => {
    expect(namespaceOf({ workspaceID: null, directory: "/a" })).toBe("/a")
  })
})

describe("socketPathFor", () => {
  it("differs across namespaces for the same server", () => {
    const a = socketPathFor(NS_A, "web1", "/home/u")
    const b = socketPathFor(NS_B, "web1", "/home/u")
    expect(a).not.toBe(b)
  })

  it("is stable for the same namespace and server", () => {
    expect(socketPathFor(NS_A, "web1", "/home/u")).toBe(socketPathFor(NS_A, "web1", "/home/u"))
  })

  it("sanitizes unsafe characters", () => {
    const p = socketPathFor(NS_A, "user@host:22", "/home/u")
    expect(p).toMatch(/^\/home\/u\/\.ssh\/opencode_[0-9a-f]{8}_/)
    expect(p.slice(p.lastIndexOf("/") + 1)).toMatch(/^opencode_[0-9a-f]{8}_user_host_22$/)
  })

  it("uses the opencode_ prefix", () => {
    expect(socketPathFor(NS_A, "web1", "/home/u")).toContain("/opencode_")
  })
})

describe("isManagedSocketFile", () => {
  it("accepts current and legacy socket names", () => {
    expect(isManagedSocketFile("opencode_deadbeef_web1")).toBe(true)
    expect(isManagedSocketFile("opencode_eea018ceeffe_tzaker-core-dev")).toBe(true)
  })

  it("rejects unrelated files", () => {
    expect(isManagedSocketFile("config")).toBe(false)
    expect(isManagedSocketFile("id_ed25519")).toBe(false)
    expect(isManagedSocketFile("known_hosts")).toBe(false)
  })
})

describe("shellQuote", () => {
  it("wraps in single quotes", () => {
    expect(shellQuote("ls -Al")).toBe("'ls -Al'")
  })

  it("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
  })
})

describe("buildRemoteCommand", () => {
  const one = [conn("web1", NS_A)]
  const two = [conn("web1", NS_A), conn("web2", NS_A)]

  it("quotes the command for a single target", () => {
    const out = buildRemoteCommand("ls -Al", one)
    expect(out).toBe(`ssh -S '/home/u/.ssh/opencode_deadbeef_web1' 'web1' 'ls -Al'`)
  })

  it("keeps shell metacharacters inside the quoted remote command", () => {
    const out = buildRemoteCommand("ls -Al; echo done", one)
    // The whole command is single-quoted: no local `;` splitting can occur.
    expect(out).toBe(`ssh -S '/home/u/.ssh/opencode_deadbeef_web1' 'web1' 'ls -Al; echo done'`)
  })

  it("escapes embedded single quotes", () => {
    const out = buildRemoteCommand("echo 'hi'", one)
    expect(out).toContain(`'echo '\\''hi'\\'''`)
  })

  it("does not interpolate command substitution", () => {
    const out = buildRemoteCommand("echo $(whoami)", one)
    expect(out).toContain(`'echo $(whoami)'`)
  })

  it("marks the single target in the description separately", () => {
    // description handling lives in index.ts; here we only assert command shape
    expect(buildRemoteCommand("ls", one)).toMatch(/^ssh -S /)
  })

  it("builds a parallel command with server markers for multiple targets", () => {
    const out = buildRemoteCommand("ls -Al", two)
    expect(out).toContain(`echo '=== server: web1 ==='`)
    expect(out).toContain(`echo '=== server: web2 ==='`)
    expect(out).toContain(`echo '=== end: web1 ==='`)
    expect(out.endsWith(" wait")).toBe(true)
    expect(out).toContain("} & {")
  })

  it("runs both targets' commands in parallel (each backgrounded)", () => {
    const out = buildRemoteCommand("ls", two)
    const backgrounded = out.match(/} &/g) ?? []
    expect(backgrounded).toHaveLength(2)
  })
})

describe("isHostInSshConfig", () => {
  const config = `
# comment Host fake
Host web1 web2
  User deploy

Host *
  ServerAliveInterval 60
`

  it("matches an exact host", () => {
    expect(isHostInSshConfig("web1", config)).toBe(true)
  })

  it("matches any host via wildcard", () => {
    expect(isHostInSshConfig("anything", config)).toBe(true)
  })

  it("does not match commented Host lines", () => {
    expect(isHostInSshConfig("fake", "# Host fake")).toBe(false)
  })

  it("returns false for an empty config", () => {
    expect(isHostInSshConfig("web1", "")).toBe(false)
  })

  it("is case-sensitive on the host name", () => {
    expect(isHostInSshConfig("WEB1", "Host web1")).toBe(false)
  })
})

describe("decide", () => {
  const local = new Map([["web1", conn("web1", NS_A)]])
  const foreign = new Map([["db1", conn("db1", NS_B)]])
  const namespaces = new Map([
    [NS_A, local],
    [NS_B, foreign],
  ])

  it("runs remote for a mention connected in this namespace", () => {
    const d = decide(["web1"], namespaces, NS_A)
    expect(d.action).toBe("remote")
    if (d.action === "remote") expect(d.targets.map((t) => t.serverName)).toEqual(["web1"])
  })

  it("fails for a mention connected only in another namespace", () => {
    const d = decide(["db1"], namespaces, NS_A)
    expect(d).toEqual({ action: "fail", message: "server db1 is not connected" })
  })

  it("never silently runs local when a foreign mention coexists with a local one", () => {
    const d = decide(["web1", "db1"], namespaces, NS_A)
    expect(d.action).toBe("fail")
  })

  it("runs local when no mention is connected anywhere", () => {
    expect(decide(["unknown"], namespaces, NS_A)).toEqual({ action: "local" })
  })

  it("runs local when there are no mentions", () => {
    expect(decide([], namespaces, NS_A)).toEqual({ action: "local" })
  })

  it("runs local when this namespace has no connections", () => {
    expect(decide(["web1"], new Map(), NS_A)).toEqual({ action: "local" })
  })

  it("lets a local mention win over the same name absent elsewhere", () => {
    const d = decide(["web1"], namespaces, NS_B)
    // web1 is only in NS_A, so from NS_B's perspective it is foreign -> fail
    expect(d).toEqual({ action: "fail", message: "server web1 is not connected" })
  })

  it("resolves a mention connected in the current namespace even if empty elsewhere", () => {
    const d = decide(["db1"], namespaces, NS_B)
    expect(d.action).toBe("remote")
  })
})

describe("stripTargetMentions", () => {
  it("strips a leading mention", () => {
    expect(stripTargetMentions("@web1 ls -Al", ["web1"])).toBe("ls -Al")
  })

  it("strips a trailing mention", () => {
    expect(stripTargetMentions("ls -Al @web1", ["web1"])).toBe("ls -Al")
  })

  it("strips a mention hidden in a trailing comment", () => {
    expect(stripTargetMentions("ls -Al # @web1", ["web1"])).toBe("ls -Al #")
  })

  it("strips an infix mention", () => {
    expect(stripTargetMentions("ls @web1 -Al", ["web1"])).toBe("ls  -Al")
  })

  it("strips multiple targets", () => {
    expect(stripTargetMentions("@web1 @web2 ls", ["web1", "web2"])).toBe("ls")
  })

  it("keeps non-target mentions", () => {
    expect(stripTargetMentions("echo hi @web1 @other", ["web1"])).toBe("echo hi  @other")
  })

  it("keeps emails untouched", () => {
    expect(stripTargetMentions("echo bob@example.com", ["example"])).toBe("echo bob@example.com")
  })

  it("returns empty when only a mention remains", () => {
    expect(stripTargetMentions("@web1", ["web1"])).toBe("")
  })

  it("is a no-op without targets", () => {
    expect(stripTargetMentions("ls -Al @web1", [])).toBe("ls -Al @web1")
  })
})

describe("refPathFor", () => {
  it("namespaces descriptor files by workspace key", () => {
    const a = refPathFor("/projects/a", "web1", "/home/u")
    const b = refPathFor("/projects/b", "web1", "/home/u")
    expect(a).not.toBe(b)
    expect(a).toMatch(/\.ssh\/opencode-refs\/opencode_[0-9a-f]{8}_web1\.md$/)
  })

  it("sanitizes server names", () => {
    expect(refPathFor("/a", "web 1!", "/home/u")).toMatch(/_web_1_\.md$/)
  })
})

describe("buildRefDescriptor", () => {
  it("mentions the server, host, and workspace in a few lines", () => {
    const text = buildRefDescriptor({ serverName: "web1", host: "web1", namespace: "/projects/a" })
    expect(text).toContain("@web1")
    expect(text).toContain("web1")
    expect(text).toContain("/projects/a")
    expect(text.split("\n").length).toBeLessThan(10)
  })
})
