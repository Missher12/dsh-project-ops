# dsh-project-ops

English | [中文](README.zh.md)

`dsh-project-ops` is an independently installable DeepSeek Harness Bundle. It adds three namespaced model tools for finding
project capabilities, listing declared project tasks, and running one selected task through the Agent's existing shell tool.

It does not patch Harness source, replace the Desktop-managed profile, create a second job system, or run anything in the
background. Installation and removal are ordinary Profile plugin transactions.

## Compatibility

Version `0.1.2` pins its runtime peer contract to:

- DeepSeek Harness packages `0.1.1-rc.2`;
- `@deepseek-ai/cordis` `4.0.1`;
- Node.js `^22.19.0 || >=24.0.0`.

Treat a different Harness release as unverified until the package tests, build, and isolated smoke pass against that release.
The package marks these peers optional only to avoid false pnpm warnings in a Profile; the Harness Host must still provide every
listed runtime package through its managed module fallback.

## Install and remove

Recommended one-command installation into the browser application's `web` Profile:

```sh
dsh plugin --profile web add https://github.com/Missher12/dsh-project-ops/releases/download/v0.1.2/dsh-project-ops-0.1.2.tgz
```

Restart that Profile so its Loader composes the added Bundle row. To build the same Bundle from source instead, run:

```sh
pnpm install --frozen-lockfile
pnpm run build
npm pack
```

Then install the local archive into the Profile that should expose the tools:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-project-ops-0.1.2.tgz
```

Remove only this Bundle with:

```sh
dsh plugin --profile web remove dsh-project-ops
```

Removal deletes the dependency and Bundle layer from that Profile. It does not rewrite historical Session tool results that
already contain a receipt.

## Model tools

### `missher_project_ops_task_list`

Takes no arguments. It reads only exact task-manifest candidates at the owning Agent Session's current working directory and
returns:

- `tasks`: `id`, display name, description, source, manifest name, SHA-256 manifest digest, and runnable state;
- `diagnostics`: bounded source, code, and message rows without manifest content.

### `missher_project_ops_task_run`

Accepts:

- `taskId`: an ID returned by `task_list`;
- `manifestDigest`: the matching lowercase SHA-256 digest returned by `task_list`.

The tool rediscovers the task immediately before dispatch. A changed digest, missing task, unavailable executor, or hidden
executor fails safely. A valid task is nested-dispatched to the Agent-visible `bash` tool on POSIX or `pwsh` on Windows, so
Harness keeps ownership of scope, approval, sandbox, cancellation, and tool-result behavior.

The returned content includes the nested tool content once and one receipt with:

- `receiptVersion`, `taskId`, `source`, and `manifestDigest`;
- `executorTool` when one was available;
- `nestedCallId`, `startedAt`, and `durationMs`;
- `outcome`: `succeeded`, `failed`, `blocked`, `aborted`, or `unavailable`;
- `exitCode` when the nested result exposes an integer exit code.

The receipt intentionally excludes command text, project paths, output, environment variables, and approval text. As an
ordinary outer tool result, the receipt remains in Session history according to Harness's existing retention behavior.

### `missher_project_ops_capability_search`

Accepts a `query` and an optional `limit` from 1 through 10. It ranks only the calling Agent's visible Harness tool schemas
plus the current project's discovered tasks. It does not search a global hidden registry or change tool scope.

## Discovery boundary

The Bundle inspects only these project-root candidates:

- `package.json`, selecting `npm`, `pnpm`, `yarn`, or `bun` from `packageManager` or one unambiguous lockfile;
- `GNUmakefile`, `makefile`, or `Makefile`, accepting simple explicit targets with a following tab recipe;
- `justfile` or `Justfile`, accepting simple public recipes with no parameters.

Each manifest is capped at 1 MiB. At most 128 deterministically ordered tasks are returned. Make pattern or special targets,
parameterized Just recipes, malformed input, ambiguous package managers, and undeclared arbitrary commands are not executed.
Task arguments are deliberately unsupported in this release.

## Verification boundary

`node scripts/smoke.mjs` packs an exact file whitelist, scans it for source paths and secret-shaped text, installs the archive
under a temporary `DSH_HOME`, composes a temporary Profile, exercises an installed temporary package task and its receipt,
removes the Bundle, and compares a hash-only top-level sentinel for the live `~/.dsh` directory. The smoke deletes its
temporary state. Version `0.1.2` passed this lifecycle on GitHub-hosted macOS, Windows, and Linux runners, in addition to local
macOS acceptance. Windows ARM and other unlisted architectures remain unverified.
