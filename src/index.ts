import { Plugin } from "@opencode/plugin"
import { spawnSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  type Connection,
  type NamespaceMap,
  buildRefDescriptor,
  buildRemoteCommand,
  decide,
  extractMentions,
  isHostInSshConfig,
  isManagedSocketFile,
  namespaceOf,
  refPathFor,
  socketPathFor,
  stripTargetMentions,
} from "./core.js"

const namespaces: NamespaceMap = new Map()
/** sessionID -> namespace key, cached because the tool hook runs on every bash call. */
const sessionNamespace = new Map<string, string>()
/**
 * Server names registered with ctx.reference (references are location-global,
 * not per namespace) mapped to the connection backing their descriptor file.
 */
const registeredReferences = new Map<string, { namespace: string; serverName: string }>()

function refsDir(): string {
  return path.join(os.homedir(), ".ssh", "opencode-refs")
}

function writeRefFile(conn: Connection) {
  try {
    fs.mkdirSync(refsDir(), { recursive: true })
    fs.writeFileSync(refPathFor(conn.namespace, conn.serverName, os.homedir()), buildRefDescriptor(conn))
  } catch {}
}

function removeRefFile(namespace: string, serverName: string) {
  try {
    fs.unlinkSync(refPathFor(namespace, serverName, os.homedir()))
  } catch {}
}

function ssh(args: string[], timeout = 15000) {
  return spawnSync("ssh", args, { stdio: "pipe", timeout, encoding: "utf8" })
}

function socketAlive(socketPath: string, host: string): boolean {
  return ssh(["-O", "check", "-S", socketPath, host], 5000).status === 0
}

function disconnectConnection(conn: Connection) {
  ssh(["-O", "stop", "-S", conn.socketPath, conn.host], 5000)
}

function readSshConfig(): string {
  try {
    return fs.readFileSync(path.join(os.homedir(), ".ssh", "config"), "utf8")
  } catch {
    return ""
  }
}

/** Remove socket files this plugin owns whose master is gone. Never touches non-socket files. */
function sweepStaleSockets() {
  const dir = path.join(os.homedir(), ".ssh")
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (!isManagedSocketFile(name)) continue
    const full = path.join(dir, name)
    try {
      if (!fs.statSync(full).isSocket()) continue
    } catch {
      continue
    }
    if (!socketAlive(full, "opencode-sweep")) {
      try {
        fs.unlinkSync(full)
      } catch {}
    }
  }
}

export default Plugin.define({
  id: "opencode-remote-ssh",
  setup: async (ctx) => {
    sweepStaleSockets()

    const namespaceFor = async (sessionID: string): Promise<string> => {
      const cached = sessionNamespace.get(sessionID)
      if (cached !== undefined) return cached
      let key: string = ctx.location.directory
      try {
        const session = await ctx.session.get({ sessionID })
        // workspaceID is present at runtime but absent from the public client type.
        key = namespaceOf(session.location as { directory: string; workspaceID?: string })
      } catch {}
      sessionNamespace.set(sessionID, key)
      return key
    }

    /**
     * Keep the (location-global) reference list equal to the union of all
     * namespaces. Each reference points at a small descriptor file (rewritten
     * here, deleted when the name leaves the union) instead of `/`, so
     * attaching `@server` injects a few lines of context, never the root fs.
     * A name present in several namespaces is backed by the first one seen.
     */
    const syncReferences = async () => {
      const union = new Map<string, Connection>()
      for (const conns of namespaces.values()) {
        for (const conn of conns.values()) {
          if (!union.has(conn.serverName)) union.set(conn.serverName, conn)
        }
      }
      const toRemove = Array.from(registeredReferences.keys()).filter((name) => !union.has(name))
      const toAdd = Array.from(union.values()).filter((conn) => {
        const backing = registeredReferences.get(conn.serverName)
        return !backing || backing.namespace !== conn.namespace
      })
      if (toRemove.length === 0 && toAdd.length === 0) return
      await ctx.reference.transform((editor) => {
        for (const name of toRemove) {
          const backing = registeredReferences.get(name)
          try {
            editor.remove(name)
          } catch {}
          if (backing) removeRefFile(backing.namespace, backing.serverName)
          registeredReferences.delete(name)
        }
        for (const conn of toAdd) {
          writeRefFile(conn)
          try {
            editor.add(conn.serverName, {
              type: "local",
              path: refPathFor(conn.namespace, conn.serverName, os.homedir()),
            })
            registeredReferences.set(conn.serverName, { namespace: conn.namespace, serverName: conn.serverName })
          } catch {}
        }
      })
      // reload() is currently a no-op client-side; TUI needs a full restart for
      // new @server completions. Keep the call so a future server fix picks it
      // up. Upstream: https://github.com/anomalyco/opencode/issues/53954
      try {
        await ctx.reference.reload()
      } catch {}
    }

    const nsConnections = (ns: string): Map<string, Connection> => {
      let conns = namespaces.get(ns)
      if (!conns) {
        conns = new Map()
        namespaces.set(ns, conns)
      }
      return conns
    }

    const notConnected = (server: string) => `server ${server} is not connected`

    await ctx.command.transform((editor) => {
      editor.add({
        name: "ssh",
        description:
          "Connect to SSH servers (space-separated). Uses hybrid validation - checks ssh config, falls back to raw host spec.",
        execute: async ({ sessionID, prompt }) => {
          const ns = await namespaceFor(sessionID)
          const conns = nsConnections(ns)
          const args = (prompt.text || "").trim().split(/\s+/).filter((a) => a.length > 0)
          if (args.length === 0) {
            await ctx.session.prompt({
              sessionID,
              text: "Usage: /ssh <server1> [server2] ...",
              delivery: "queue",
            })
            return
          }
          const sshConfig = readSshConfig()
          const results: string[] = []
          for (const server of args) {
            const existing = conns.get(server)
            if (existing && socketAlive(existing.socketPath, existing.host)) {
              results.push(`- ${server}: already connected`)
              continue
            }
            if (existing) {
              conns.delete(server)
              try {
                fs.unlinkSync(existing.socketPath)
              } catch {}
            }
            const socketPath = socketPathFor(ns, server, os.homedir())
            const inConfig = isHostInSshConfig(server, sshConfig)
            const connect = ssh(["-MNf", "-S", socketPath, server])
            if (connect.status === 0 && socketAlive(socketPath, server)) {
              conns.set(server, { host: server, socketPath, serverName: server, namespace: ns })
              results.push(`✓ Connected to ${server}${inConfig ? " (from ssh config)" : " (raw host)"}`)
            } else {
              const detail = (connect.stderr || "").trim().split("\n").slice(-1)[0] || "connection not established"
              ssh(["-O", "stop", "-S", socketPath, server], 5000)
              try {
                fs.unlinkSync(socketPath)
              } catch {}
              results.push(`✗ Failed to connect to ${server}: ${detail}`)
            }
          }
          await syncReferences()
          await ctx.session.prompt({
            sessionID,
            text: results.join("\n"),
            delivery: "queue",
          })
        },
      })

      editor.add({
        name: "disconnect_ssh",
        description: "Disconnect from SSH servers in this workspace. Use 'all' to disconnect all of them.",
        execute: async ({ sessionID, prompt }) => {
          const ns = await namespaceFor(sessionID)
          const conns = nsConnections(ns)
          const args = (prompt.text || "").trim().split(/\s+/).filter((a) => a.length > 0)
          if (args.length === 0) {
            await ctx.session.prompt({
              sessionID,
              text: "Usage: /disconnect_ssh <server1> [server2] ... | all",
              delivery: "queue",
            })
            return
          }
          const results: string[] = []
          if (args.includes("all")) {
            const count = conns.size
            for (const conn of conns.values()) disconnectConnection(conn)
            conns.clear()
            await syncReferences()
            await ctx.session.prompt({
              sessionID,
              text: count === 0 ? "No connected servers" : `Disconnected ${count} server(s)`,
              delivery: "queue",
            })
            return
          }
          for (const server of args) {
            const conn = conns.get(server)
            if (!conn) {
              results.push(`${notConnected(server)}`)
              continue
            }
            disconnectConnection(conn)
            conns.delete(server)
            results.push(`✓ Disconnected ${server}`)
          }
          await syncReferences()
          await ctx.session.prompt({
            sessionID,
            text: results.join("\n") || "No connected servers",
            delivery: "queue",
          })
        },
      })

      editor.add({
        name: "list_ssh",
        description: "List SSH servers connected in this workspace",
        execute: async ({ sessionID }) => {
          const ns = await namespaceFor(sessionID)
          const conns = namespaces.get(ns)
          if (!conns || conns.size === 0) {
            await ctx.session.prompt({
              sessionID,
              text: "No connected servers",
              delivery: "queue",
            })
            return
          }
          const servers = Array.from(conns.values()).map((conn) =>
            socketAlive(conn.socketPath, conn.host)
              ? `- ${conn.serverName} (${conn.host}) — alive`
              : `- ${conn.serverName} (${conn.host}) — unreachable`,
          )
          await ctx.session.prompt({
            sessionID,
            text: servers.join("\n"),
            delivery: "queue",
          })
        },
      })
    })

    const hookReg = await ctx.tool.hook("execute.before", async (event) => {
      // The shell tool is exposed as both "bash" (historic) and "shell" (current).
      if (event.tool !== "bash" && event.tool !== "shell") return
      const input = event.input as { command?: unknown; description?: unknown }
      const cmd = typeof input.command === "string" ? input.command : ""
      if (!cmd) return
      const desc = typeof input.description === "string" ? input.description : ""
      const mentions = extractMentions(`${cmd} ${desc}`)
      if (mentions.length === 0) return

      const ns = await namespaceFor(event.sessionID)
      const decision = decide(mentions, namespaces, ns)
      if (decision.action === "local") return
      if (decision.action === "fail") throw new Error(decision.message)

      // Never wrap a command in a dead ControlMaster: report and drop the connection.
      const targets: Connection[] = []
      for (const conn of decision.targets) {
        if (socketAlive(conn.socketPath, conn.host)) {
          targets.push(conn)
          continue
        }
        namespaces.get(conn.namespace)?.delete(conn.serverName)
        try {
          fs.unlinkSync(conn.socketPath)
        } catch {}
        await syncReferences()
        throw new Error(notConnected(conn.serverName))
      }

      const cleanCmd = stripTargetMentions(
        cmd,
        targets.map((t) => t.serverName),
      )
      if (!cleanCmd) throw new Error("empty command after stripping server mention")
      input.command = buildRemoteCommand(cleanCmd, targets)
      if (targets.length === 1 && desc) {
        input.description = `[remote ${targets[0].serverName}] ${desc}`
      }
    })

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "session.deleted") {
            const properties = (event as { properties?: { sessionID?: string } }).properties
            const sessionId = properties?.sessionID
            if (sessionId) sessionNamespace.delete(sessionId)
          }
        }
      } catch {}
    })()

    return async () => {
      controller.abort()
      await hookReg.dispose()
      for (const conns of namespaces.values()) {
        for (const conn of conns.values()) disconnectConnection(conn)
      }
      for (const backing of registeredReferences.values()) {
        removeRefFile(backing.namespace, backing.serverName)
      }
      namespaces.clear()
      sessionNamespace.clear()
      registeredReferences.clear()
    }
  },
})
