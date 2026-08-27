# dsh-project-ops

English | [中文](README.zh.md)

`dsh-project-ops` is an independently installable execution-autopilot Bundle for DeepSeek Harness. It gives an Agent a bounded map of declared project tasks, plans checks affected by changed files, hands long work to Harness's existing Jobs runtime, and evaluates output-free verification receipts.

It does not patch Harness source, replace a Desktop-managed Profile, accept arbitrary command text, or create another shell, job registry, workflow engine, reviewer, or sandbox. Harness remains the authority for tool scope, approvals, execution policy, cancellation, output retention, and owner isolation.

## Compatibility

Version `0.2.0` pins its verified runtime contract to:

- DeepSeek Harness packages `0.1.1-rc.2`;
- `@deepseek-ai/cordis` `4.0.1`;
- Node.js `^22.19.0 || >=24.0.0`.

The Profile must provide `fs`, `tools`, and `jobs`, plus an Agent-visible `bash` tool on POSIX or `pwsh` on Windows. Auto/background execution additionally requires that visible shell definition to expose `run_in_background` and that the Profile load the ordinary Harness job controller tools.

Treat another Harness release as unverified until typecheck, tests, build, and the isolated package lifecycle smoke pass against it. Runtime peers are optional in the npm manifest only to avoid false Profile-install warnings; the Harness Host still has to supply them.

## One-command install or upgrade

Install into the browser application's `web` Profile, or run the same command to upgrade an earlier Project Ops release:

```sh
dsh plugin --profile web add https://github.com/Missher12/dsh-project-ops/releases/download/v0.2.0/dsh-project-ops-0.2.0.tgz
```

Restart that Profile so its Loader recomposes the Bundle row. Remove only this Bundle with:

```sh
dsh plugin --profile web remove dsh-project-ops
```

To build the same Bundle from source:

```sh
pnpm install --frozen-lockfile
pnpm run build
npm pack
```

## Six model tools

### `missher_project_ops_task_list`

Lists tasks from the Session cwd root and bounded declared package workspaces. Each row contains task identity, source manifest and SHA-256 digest, relative workspace, optional package name, inferred purpose, dependency task IDs, and runnable state. It never returns task command text.

### `missher_project_ops_task_plan`

Accepts one through 256 workspace-relative `changedFiles` and a goal:

- `verify`: test, lint, and typecheck tasks;
- `build`: build tasks;
- `all`: the four safe check purposes above; formatting and arbitrary `other` scripts are not auto-selected.

The planner finds directly affected workspaces, reverse local dependents, task dependencies, and matching root tasks. It returns stable topological order, affected workspace names, diagnostics, a changed-files digest, and a plan digest. Root-level changes conservatively affect every declared workspace.

### `missher_project_ops_task_run`

Accepts a fresh task ID and matching manifest digest plus an optional mode:

- `foreground` (default for backward compatibility): wait for the visible shell tool;
- `background`: start through the shell's existing `run_in_background` route and return its Harness job ID;
- `auto`: start through the same background route, wait 1–10000 ms (default 3000), and return a terminal receipt when the task finishes quickly or a running receipt when it remains live.

Harness cannot promote an already-started foreground process. Auto mode is therefore background-first with a bounded wait. It falls back to foreground only when background capability is absent before dispatch; a started job is never rerun.

Every task is rediscovered immediately before dispatch. Changed manifests, missing tasks, hidden executors, or non-runnable declarations fail closed. Package workspace tasks execute in their declared workspace through the Agent-visible shell.

### `missher_project_ops_task_collect`

Polls or waits for a job returned by Project Ops. Harness's JobRegistry enforces caller ownership. The collector also verifies that the job's internal shell label still matches the freshly rediscovered task command before returning incremental output and a new receipt.

### `missher_project_ops_verification_gate`

Recomputes the affected-task plan from `changedFiles` and `goal`, then checks the supplied plan digest and version-2 receipts against current manifests. Verdicts are:

- `passed`: every required task has a fresh successful receipt;
- `pending`: required evidence is missing or still running;
- `failed`: a required task failed, was blocked, aborted, or unavailable;
- `stale`: the plan, required task set, task metadata, or manifest digest changed.

The gate returns task IDs and reason codes only. It does not repeat changed paths, commands, output, call metadata, environment values, or approval content.

### `missher_project_ops_capability_search`

Ranks only the calling Agent's visible Harness tool schemas plus tasks discovered in its current project. It does not search a hidden global registry or widen tool scope.

## Discovery boundary

Root candidates remain `package.json`, GNUmakefile/Makefile variants, and Justfile variants. Package workspaces come only from `package.json#workspaces` or the list under `pnpm-workspace.yaml#packages`.

Workspace patterns may contain literal path segments, `*`, and terminal `**`. Absolute paths, parent traversal, negation, backslashes in declarations, unsupported glob syntax, and symlink directories are rejected or skipped. Bounds are:

- 1 MiB per manifest;
- 64 workspace package directories;
- 128 workspace patterns;
- traversal depth 8 and 256 inspected directories;
- 256 tasks total;
- 256 changed paths, at most 512 characters each.

Nested packages inherit the root package manager when they do not declare one. A local package dependency adds same-purpose task edges when both packages declare that purpose. Root Make targets must be simple explicit targets with a following tab recipe; Just recipes must be public and parameterless.

## Receipt boundary

Version-2 receipts contain task/source/workspace/purpose identity, manifest digest, execution mode, optional executor and job ID, nested call ID, start time, duration, outcome, and optional exit code. They deliberately exclude commands, absolute paths, output, environment variables, sandbox policy text, and approval text.

Receipts are evidence, not authority. The verification gate always rediscovers manifests and recomputes the plan before accepting them.

## Verification boundary

`pnpm run smoke:package` builds an exact-whitelist archive, scans it for source paths and secret-shaped text, installs it under a temporary `DSH_HOME`, composes a temporary Profile, exercises an installed workspace task and verification receipt, removes the Bundle, and compares a hash-only top-level sentinel for the live `~/.dsh` directory.

GitHub CI runs typecheck, 42 automated tests, build, and that complete lifecycle on hosted Linux, macOS, and Windows runners. Windows ARM and unlisted architectures remain unverified.
