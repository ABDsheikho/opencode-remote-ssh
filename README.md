# opencode-remote-ssh

OpenCode V2 plugin for SSH remote connections with @-mention targeting.

## Features

- Commands: `/ssh <server1> [server2] ...`,
  `/disconnect_ssh <server1> [server2] ... | all`, `/list_ssh`
- Dynamic @-mentions (`@servername`) for connected servers
- Targeted bash execution: only wraps bash commands when connected servers are
  @-mentioned; otherwise runs locally
- Hybrid validation: checks `~/.ssh/config`, falls back to raw host specs
- Per-session connections with automatic cleanup on session end
- Parallel execution for multiple mentioned servers

## Installation

### Prerequisites

- Node.js 18+ and npm
- SSH configured with `ssh-agent` (or keychain) so connections don't prompt for
  passphrases
- OpenCode V2

### From source (this repository)

```bash
git clone https://github.com/ABDsheikho/opencode-remote-ssh
cd opencode-remote-ssh
npm install
npm run build
```

The included `opencode.jsonc` intentionally keeps `plugins` empty so the plugin
never loads twice in this directory (two copies mean two separate in-memory
registries — see "Deploying" below). To load locally, add
`"plugins": ["./dist"]` (directory form — file paths are rejected by current
OpenCode with "configured plugin path must be a directory").

### As a project plugin

1. Build the plugin as above
1. Copy it to your project, e.g. `.opencode/plugins/opencode-remote-ssh/`
   (include `dist/`, `package.json`, etc.)
1. Or add to your project's `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./path/to/opencode-remote-ssh/dist"]
}
```

### As a global plugin

Create `~/.config/opencode/plugins/opencode-remote-ssh/` and copy the built
files there. OpenCode will auto-discover plugins in
`~/.config/opencode/plugins/`.

## Usage

1. Run `opencode` in the directory where the plugin is configured
1. Use `/ssh myserver` to connect
1. Use `@myserver echo hello` to run commands on that server
1. Use `/list_ssh` to list connections
1. Use `/disconnect_ssh myserver` or `/disconnect_ssh all`

Plain sentences work too once connected — ask about a server by name and the
model runs it remotely (via shell + mention, or the `ssh_exec` tool).

Run one command on several servers at once — output is grouped per server:

```text
@web1 @web2 uptime
```

## References

Each connection registers `@servername` as a reference pointing at a small
descriptor file in `~/.ssh/opencode-refs/` (namespaced like the sockets, deleted
on disconnect). Attaching the reference injects a few lines (host, workspace,
mention syntax) — never filesystem content.

> [!NOTE] The client caches the reference list per process and the server
> currently emits no invalidation when plugins update it, so `@servername`
> appears in `@` completions only after a **full TUI restart** (a new session in
> the same TUI is not enough). Routing itself needs no restart — mentions work
> in any session once connected.
>
> Tracked upstream:
> [`ctx.reference.reload()` is a no-op — TUI reference list never refreshes](https://github.com/anomalyco/opencode/issues/53954)

## Development

```bash
npm install
npm run typecheck  # src + tests, no emit
npm run build      # emits dist/ from src only
npm test
```

## Manual verification (live server)

Unit tests (`npm test`, 49 tests) cover mention parsing, the namespace decision
table, quoting, and command building. The following need a live OpenCode server:

1. **Thrown message reaches the model verbatim.** Mention a server connected in
   another workspace (e.g. `@web1 ls` from a different directory). The shell
   tool call must fail with exactly `server web1 is not connected`, and the
   model should see that text.
1. **Cross-directory isolation.** `/ssh web1` in directory A, then `@web1 ...`
   from a session in directory B. Expect the failure from (1), never silent
   local execution. A mention of a server connected nowhere stays a normal local
   command.
1. **Reference visibility.** `@server` references are registered location-global
   (union across namespaces), so tab-completion may suggest a server that the
   current workspace cannot use — that mention then fails per (1) by design.
1. **One copy at a time.** If the global config and a project config each load a
   copy of this plugin in the same server process, they get separate in-memory
   registries (verified: the same entrypoint loaded twice). Disable one copy
   when testing the other.
1. **Tool id.** The hook matches both `bash` (historic) and `shell` (current
   tool id, verified live). If mentions stop rewriting after an OpenCode
   upgrade, check the tool id first.

## Deploying

`npm run build` emits two files: `dist/index.js` + `dist/core.js` (`index.js`
imports `./core.js`). Loading is via a single absolute-path entry in the global
config — `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": ["/path/to/opencode-remote-ssh/dist"]
}
```

> [!WARNING] Configured plugin paths must be directories (file paths are
> rejected). Keep the project-local `opencode.jsonc` with an empty `plugins`
> array — loading two copies in one server process creates two separate
> registries.

## Similar projects

- [opencode-ssh](https://github.com/snez/opencode-ssh) — session-wide remote
  mode: say `ssh <host>` and every command runs on that one server.
- [opencode-remote-ssh by TyRoden](https://github.com/TyRoden/opencode-remote-ssh)
  — provider-based remote workspaces via a Go stub installed on each host.

## Transparency

This plugin is developed using AI tools and agents, with human review of every
change.

## License

MIT — see [LICENSE](./LICENSE).
