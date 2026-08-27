# Execution Autopilot 0.2 Design

## Goal

Turn `dsh-project-ops` from a project-root task launcher into an independently installable execution-closure Bundle for DeepSeek Harness. Version 0.2 must help an Agent understand a bounded JavaScript monorepo, select the checks affected by a change, hand long work to Harness's existing Jobs runtime, and prove whether the planned checks passed without storing commands, paths, output, or secrets in durable receipts.

## Product boundary

The Bundle remains an orchestration layer. It does not replace Harness Shell, Jobs, Workflow, filesystem policy, approval, sandbox, Session persistence, subagents, or LSP. It never accepts arbitrary command text. It executes only tasks rediscovered from bounded manifests and keeps every shell dispatch under the calling Agent's visible tool scope.

Version 0.2 deliberately does not add an autonomous code-review subagent. The current generic subagent tool cannot receive a per-call enforced read-only tool filter, so a prompt-only reviewer would overstate its safety boundary. The deterministic verification gate in this release is the safe prerequisite for a later review Bundle.

## Architecture

### Workspace discovery

The filesystem adapter gains stable directory listing and relative manifest reads. Discovery reads the root `package.json`, then expands only bounded workspace patterns declared by `package.json#workspaces` or `pnpm-workspace.yaml`. Supported patterns contain literal segments, `*`, and a terminal `**`; absolute paths, parent traversal, negation, and malformed patterns are rejected diagnostically.

Traversal is capped at 64 workspaces, depth 8, 256 directories, 1 MiB per manifest, and 256 tasks. Symlink directory entries are not traversed. Root Make and Just tasks remain supported. Nested package tasks inherit the root package manager when their own manifest does not select one.

Each task reports its relative workspace, package name when available, purpose (`test`, `lint`, `typecheck`, `build`, `format`, or `other`), and same-purpose dependency task IDs derived from local package dependencies. Existing root package task IDs remain stable; nested IDs include their workspace.

### Affected-task planning

`missher_project_ops_task_plan` accepts a bounded list of workspace-relative changed files and a goal (`verify`, `build`, or `all`). It normalizes and sorts the paths, determines affected workspaces, selects relevant task purposes, closes over task dependencies, topologically orders the result, and emits a SHA-256 plan digest.

Root-level changes conservatively affect every workspace. Changes within a workspace affect that workspace and its reverse local dependents. Root tasks of a matching purpose are included for every plan. Cycles are returned in stable order with a diagnostic rather than guessed away.

### Execution lifecycle

`missher_project_ops_task_run` keeps the existing ID and manifest-digest freshness checks and adds `mode`:

- `foreground`: existing nested shell behavior.
- `background`: require a visible shell definition exposing `run_in_background` and the existing Jobs service; return immediately with a job receipt.
- `auto`: start through the existing shell's background route, wait up to a bounded interval, and return either a terminal receipt plus collected output or a running receipt with the Harness job ID. If background is unavailable, `auto` safely falls back to foreground.

Harness cannot promote a process already started in foreground, so `auto` is background-first with a short wait. The Bundle does not register jobs itself and does not create a second job state machine.

`missher_project_ops_task_collect` waits for or polls a previously returned job using `ctx.jobs`, consumes only that caller-owned job's output, and projects its state into a version-2 execution receipt.

### Verification gate

`missher_project_ops_verification_gate` recomputes the affected-task plan from the supplied changed files and goal, compares the plan digest, rediscovers current manifests, and evaluates supplied version-2 receipts.

The verdict is:

- `passed` when every currently required task has a fresh successful receipt;
- `pending` when all present receipts are fresh and at least one required task is running or missing;
- `failed` when a required receipt failed, was blocked, aborted, or unavailable;
- `stale` when the plan digest, task manifest digest, or required task set changed.

The result lists only task IDs and bounded reason codes. It never stores task output, command text, absolute paths, environment values, or approval content.

## Tool surface

Version 0.2 registers exactly six namespaced tools:

1. `missher_project_ops_task_list`
2. `missher_project_ops_task_plan`
3. `missher_project_ops_task_run`
4. `missher_project_ops_task_collect`
5. `missher_project_ops_verification_gate`
6. `missher_project_ops_capability_search`

Capability search continues to rank only tools visible to the calling Agent plus tasks discovered in its current project.

## Errors and safety

- All user-shaped strings have length and syntax bounds.
- Workspace resolution remains under the Session cwd and skips symlink traversal.
- A task is rediscovered immediately before every dispatch.
- Background access is fenced by Harness's owner-aware JobRegistry.
- Unsupported workspace syntax produces diagnostics and never widens traversal.
- Auto-mode fallback is allowed only when the existing background capability is unavailable before execution; a started background job is never rerun in foreground.
- Receipts are output-free and versioned.

## Verification and release

Development follows red-green-refactor tests for workspace expansion, planning, auto/background receipts, collection, and gate verdicts. The existing package lifecycle smoke expands to exercise a workspace task, an auto execution receipt, collection when applicable, and verification-gate success under a temporary `DSH_HOME`.

Release acceptance requires typecheck, all unit/integration tests, build, exact-whitelist package smoke, `npm pack`, public GitHub asset re-download, byte-size and SHA-256 equality, and preservation of the existing `0.1.2` release.
