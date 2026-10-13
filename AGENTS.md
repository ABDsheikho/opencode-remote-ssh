# AGENTS.md — opencode-remote-ssh

OpenCode V2 plugin: `/ssh`, `/disconnect_ssh`, `/list_ssh` + `@server` targeted
remote execution.

## Commands

- `npm run typecheck` — `tsc --noEmit`, covers `src + tests`
- `npm run build` — `tsc -p tsconfig.build.json`, emits `dist/` from `src` only
- `npm test` — `vitest run tests` (mention parsing, namespace table, quoting,
  command building)
- Focused: `npx vitest run tests/core.test.ts -t "<test name>"`
- `npm run dev` — `tsc --watch -p tsconfig.build.json`
- Order: `typecheck` → `test` before `build`. No CI config in repo.
- Format (mdformat CLI, no config):
  `mdformat --wrap 80 --check README.md AGENTS.md`, write with
  `mdformat --wrap 80 README.md AGENTS.md`. Keep prose lines ≤80 chars.

## Structure

- `src/index.ts` — plugin entrypoint: commands, `tool.hook("execute.before")`,
  reference sync, cleanup. All side effects (ssh spawn, fs, sockets) live here.
- `src/core.ts` — pure logic, fully unit-tested: `extractMentions`,
  `stripTargetMentions`, `decide`, `buildRemoteCommand`, `namespaceOf`,
  `socketPathFor`/`refPathFor`, `isHostInSshConfig`.
- `tests/core.test.ts` — unit tests for `core.ts` only; `index.ts` requires live
  OpenCode server (see README "Manual verification").

## Gotchas agents will miss

- Plugin paths must be **directories**: `"plugins": ["/path/.../dist"]`. File
  paths are rejected by OpenCode.
- Never load two copies at once: global + project configs in the same server =
  separate in-memory registries. This repo's `opencode.jsonc` intentionally
  keeps `"plugins": []` to avoid double-load during dev.
- `dist/` is gitignored but required at runtime; `build` emits `dist/index.js` +
  `dist/core.js`.
- Tool hook must match **both** `bash` (historic) and `shell` (current) tool
  ids. If mentions stop rewriting after upgrade, check id first.
- Namespace isolation: key = `workspaceID ?? directory`. `decide()` fails
  (`server X is not connected`, thrown verbatim to model) on cross-namespace
  mention — never silently runs local. Unknown mention = local passthrough by
  design.
- `@server` references are location-global union across namespaces, so
  completion may suggest a server the current workspace can't use (fails per
  above by design). Descriptors live in `~/.ssh/opencode-refs/`, sockets
  `~/.ssh/opencode_<nsHash>_<server>`.
- TUI caches reference list per process: new `@server` completions need **full
  TUI restart**, but routing works immediately. Upstream:
  `ctx.reference.reload()` never invalidates the client —
  https://github.com/anomalyco/opencode/issues/53954 (open, `reproduced`). If
  that issue closes fixed, retest and drop the restart note.
- SSH needs passphrase-less auth (`ssh-agent`/keychain); connections use
  ControlMaster (`-MNf` / `-O check` / `-O stop`).
