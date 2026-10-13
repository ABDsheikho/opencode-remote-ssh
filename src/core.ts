import * as crypto from "crypto"
import * as path from "path"

export interface Connection {
  host: string
  socketPath: string
  serverName: string
  namespace: string
}

/** Connections grouped by namespace key. */
export type NamespaceMap = Map<string, Map<string, Connection>>

/**
 * Extract @server mentions from free text. Deduplicates, preserves first-seen order.
 *
 * - The negative lookbehind skips emails (`bob@example.com`), where @ is preceded by a word char.
 * - Punctuation is excluded from both halves, so `@web1,` yields `web1`, not `web1,`.
 */
export function extractMentions(text: string): string[] {
  const mentions = new Set<string>()
  const regex = /(?<![\w@.])@([^\s@.,!?;:()"\[\]{}<>]+)/g
  let match
  while ((match = regex.exec(text)) !== null) {
    mentions.add(match[1])
  }
  return Array.from(mentions)
}

/**
 * Remove `@server` mentions for resolved targets from a shell command.
 * Only names in `targetNames` are removed; other `@words` and emails are kept.
 * Uses the same boundaries as `extractMentions`, then trims. Inner spacing
 * (including inside quotes) is preserved; double spaces left behind are
 * harmless to the shell.
 */
export function stripTargetMentions(cmd: string, targetNames: string[]): string {
  if (targetNames.length === 0) return cmd
  const targets = new Set(targetNames)
  const stripped = cmd.replace(/(?<![\w@.])@([^\s@.,!?;:()"\[\]{}<>]+)/g, (m, name: string) =>
    targets.has(name) ? "" : m,
  )
  return stripped.trim()
}

/**
 * Namespace key for a session: workspaceID when present, otherwise the directory.
 * Sessions sharing a key share SSH connections; other namespaces cannot target them.
 */
export function namespaceOf(location: { workspaceID?: string | null; directory: string }): string {
  return location.workspaceID ?? location.directory
}

/** Socket path namespaced by workspace key so `/disconnect_ssh all` cannot cross namespaces. */
export function socketPathFor(namespace: string, server: string, homedir: string): string {
  const nsHash = crypto.createHash("sha1").update(namespace).digest("hex").slice(0, 8)
  const sanitized = server.replace(/[^a-zA-Z0-9_-]/g, "_")
  return path.join(homedir, ".ssh", `opencode_${nsHash}_${sanitized}`)
}

/** Descriptor file path for a connection's reference entry (same namespacing as sockets). */
export function refPathFor(namespace: string, server: string, homedir: string): string {
  const nsHash = crypto.createHash("sha1").update(namespace).digest("hex").slice(0, 8)
  const sanitized = server.replace(/[^a-zA-Z0-9_-]/g, "_")
  return path.join(homedir, ".ssh", "opencode-refs", `opencode_${nsHash}_${sanitized}.md`)
}

/**
 * Markdown attached when a `@server` reference is used. Kept to a few lines so
 * attaching a server mention never injects a large or sensitive context blob.
 */
export function buildRefDescriptor(conn: { serverName: string; host: string; namespace: string }): string {
  return `# SSH server: ${conn.serverName}\n\nConnected via opencode-remote-ssh. Mention as \`@${conn.serverName}\` in shell commands to run them on this host.\n\n- host: ${conn.host}\n- workspace: ${conn.namespace}\n`
}

/** Single-quote a value for the local shell. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll(`'`, `'\\''`)}'`
}

/** True for socket files this plugin owns (current or legacy naming). */
export function isManagedSocketFile(name: string): boolean {
  return name.startsWith("opencode_")
}

/**
 * Build the local shell command that runs `cmd` on each target over its ControlMaster socket.
 * Multiple targets run in parallel, each prefixed and suffixed with server markers.
 */
export function buildRemoteCommand(cmd: string, targets: Connection[]): string {
  const quotedCmd = shellQuote(cmd)
  if (targets.length === 1) {
    const t = targets[0]
    return `ssh -S ${shellQuote(t.socketPath)} ${shellQuote(t.host)} ${quotedCmd}`
  }
  const parts = targets.map((t) => {
    const header = shellQuote(`=== server: ${t.serverName} ===`)
    const footer = shellQuote(`=== end: ${t.serverName} ===`)
    return `echo ${header} && ssh -S ${shellQuote(t.socketPath)} ${shellQuote(t.host)} ${quotedCmd} 2>&1; echo ${footer}`
  })
  return `${parts.map((p) => `{ ${p} } &`).join(" ")} wait`
}

/**
 * Normalize a server arg from /ssh, /disconnect_ssh, or ssh_exec.
 * A leading @ is forgiven (users habitually @-mention servers) but flagged,
 * since connection keys are always stored bare.
 */
export function normalizeServerArg(arg: string): { name: string; hadAt: boolean } {
  const hadAt = arg.startsWith("@")
  return { name: hadAt ? arg.replace(/^@+/, "") : arg, hadAt }
}

/** Minimal ~/.ssh/config Host parser. A `*` wildcard matches any host. */
export function isHostInSshConfig(host: string, configText: string): boolean {
  const lines = configText.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const match = trimmed.match(/^Host\s+(.+)$/i)
    if (!match) continue
    for (const h of match[1].split(/\s+/)) {
      if (h === host || h === "*") return true
    }
  }
  return false
}

export type Decision =
  | { action: "local" }
  | { action: "fail"; message: string }
  | { action: "remote"; targets: Connection[] }

/**
 * Decide how a bash command mentioning servers should run.
 *
 * - Mention connected in this namespace  -> remote
 * - Mention connected in another namespace -> fail (never silently run local)
 * - Mention connected nowhere            -> local (indistinguishable from prose)
 */
export function decide(
  mentions: string[],
  namespaces: NamespaceMap,
  currentNamespace: string,
): Decision {
  const local = namespaces.get(currentNamespace)
  const targets: Connection[] = []
  for (const mention of mentions) {
    const own = local?.get(mention)
    if (own) {
      targets.push(own)
      continue
    }
    for (const [ns, conns] of namespaces) {
      if (ns === currentNamespace) continue
      if (conns.has(mention)) {
        return { action: "fail", message: `server ${mention} is not connected` }
      }
    }
  }
  if (targets.length === 0) return { action: "local" }
  return { action: "remote", targets }
}
