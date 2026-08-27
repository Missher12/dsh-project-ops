# Execution Autopilot 0.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `dsh-project-ops` 0.2.0 as a bounded monorepo-aware execution and verification closure that reuses DeepSeek Harness Shell and Jobs.

**Architecture:** Extend manifest discovery with bounded workspace traversal, derive a deterministic affected-task graph, and add background-first auto execution plus owner-fenced collection. Recompute the plan and current manifest digests in a stateless verification gate so stale or incomplete evidence cannot pass.

**Tech Stack:** TypeScript 6, Cordis 4, DeepSeek Harness 0.1.1-rc.2 service contracts, Vitest 4, tsdown, pnpm 11.

---

### Task 1: Workspace-aware task contracts and discovery

**Files:**
- Modify: `src/contracts.ts`
- Modify: `src/task-discovery.ts`
- Modify: `tests/task-discovery.spec.ts`

- [ ] **Step 1: Write failing workspace discovery tests**

Add a directory-capable test reader and cases proving that `packages/*` expands deterministically, nested tasks inherit the root package manager, dependency task IDs point to local packages, malformed/escaping patterns are diagnostic-only, and the workspace/directory/task caps hold.

```ts
const result = await discoverProjectTasks(reader({
  'package.json': JSON.stringify({ packageManager: 'pnpm@11.7.0', workspaces: ['packages/*'] }),
  'packages/a/package.json': JSON.stringify({ name: '@acme/a', scripts: { build: 'tsc' } }),
  'packages/b/package.json': JSON.stringify({
    name: '@acme/b',
    dependencies: { '@acme/a': 'workspace:*' },
    scripts: { build: 'tsc', test: 'vitest' },
  }),
}))
expect(result.tasks.find(task => task.id === 'package@packages/b:build')).toMatchObject({
  workspace: 'packages/b',
  packageName: '@acme/b',
  purpose: 'build',
  dependsOn: ['package@packages/a:build'],
})
```

- [ ] **Step 2: Run discovery tests and verify RED**

Run: `pnpm vitest run tests/task-discovery.spec.ts`

Expected: FAIL because `ManifestReader.listDirectories`, workspace fields, and nested task discovery do not exist.

- [ ] **Step 3: Implement bounded workspace discovery**

Extend `ProjectTask` and package invocations with:

```ts
export type TaskPurpose = 'test' | 'lint' | 'typecheck' | 'build' | 'format' | 'other'

export interface ProjectTask {
  // existing fields
  workspace: string
  packageName?: string
  purpose: TaskPurpose
  dependsOn: string[]
}
```

Extend `ManifestReader` with `listDirectories(path)` and read candidates by normalized relative path. Parse bounded `workspaces` declarations, expand only literal/`*`/terminal-`**` patterns, skip symlinks at the filesystem adapter, parse at most 64 nested package manifests, and add same-purpose dependency edges after all packages are known. Keep root package IDs unchanged and use `package@<workspace>:<script>` for nested IDs.

- [ ] **Step 4: Run discovery tests and verify GREEN**

Run: `pnpm vitest run tests/task-discovery.spec.ts`

Expected: all workspace and legacy discovery tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/contracts.ts src/task-discovery.ts tests/task-discovery.spec.ts
git commit -m "feat: discover bounded monorepo tasks"
```

### Task 2: Deterministic affected-task planning

**Files:**
- Create: `src/task-planning.ts`
- Create: `tests/task-planning.spec.ts`

- [ ] **Step 1: Write failing planning tests**

Cover path rejection, workspace containment, root-wide changes, reverse dependents, purpose selection, dependency closure, stable topological order, cycle diagnostics, and plan digest changes.

```ts
const plan = createTaskPlan(tasks, ['packages/a/src/index.ts'], 'verify')
expect(plan.tasks.map(task => task.id)).toEqual([
  'package@packages/a:test',
  'package@packages/b:test',
  'package:test',
])
expect(plan.planDigest).toMatch(/^[a-f0-9]{64}$/)
```

- [ ] **Step 2: Run planning tests and verify RED**

Run: `pnpm vitest run tests/task-planning.spec.ts`

Expected: FAIL because `createTaskPlan` is missing.

- [ ] **Step 3: Implement task planning**

Export:

```ts
export type PlanGoal = 'verify' | 'build' | 'all'
export interface TaskPlan {
  planVersion: 1
  goal: PlanGoal
  changedFilesDigest: string
  planDigest: string
  tasks: ProjectTask[]
  diagnostics: DiscoveryDiagnostic[]
}
export function createTaskPlan(tasks: readonly ProjectTask[], changedFiles: readonly string[], goal: PlanGoal): TaskPlan
```

Normalize only relative POSIX-style paths with at most 512 characters and reject `..`, absolute forms, NUL, and more than 256 entries. Compute reverse workspace dependency impact, select goal purposes, close over dependencies, stable-toposort, and digest a canonical JSON projection containing goal, changed-file digest, task IDs, manifest digests, and dependency IDs.

- [ ] **Step 4: Run planning tests and verify GREEN**

Run: `pnpm vitest run tests/task-planning.spec.ts`

Expected: all planning tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/task-planning.ts tests/task-planning.spec.ts
git commit -m "feat: plan affected project checks"
```

### Task 3: Harness Jobs execution receipts and collection

**Files:**
- Modify: `src/task-execution.ts`
- Modify: `tests/task-execution.spec.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Write failing receipt tests**

Add tests for workspace-aware workdirs, receipt version 2, `running` background receipts, terminal JobSnapshot mapping, exit-code extraction, blocked/killed states, and output-free serialization.

```ts
expect(createBackgroundReceipt({ task, jobId: 'bash-1', snapshot: running, ...timing })).toMatchObject({
  receiptVersion: 2,
  executionMode: 'background',
  outcome: 'running',
  jobId: 'bash-1',
  workspace: 'packages/a',
})
```

- [ ] **Step 2: Run execution helper tests and verify RED**

Run: `pnpm vitest run tests/task-execution.spec.ts`

Expected: FAIL because version-2/background receipt helpers do not exist.

- [ ] **Step 3: Implement version-2 execution helpers**

Add `@deepseek-ai/dsh-jobs` 0.1.1-rc.2 as an optional runtime peer and direct dev dependency. Add `@deepseek-ai/dsh-jobs-local` as a dev dependency for integration tests. Define:

```ts
export type ExecutionOutcome = 'running' | 'succeeded' | 'failed' | 'blocked' | 'aborted' | 'unavailable'
export interface ExecutionReceipt {
  receiptVersion: 2
  taskId: string
  source: TaskSource
  workspace: string
  purpose: TaskPurpose
  manifestDigest: string
  executionMode: 'foreground' | 'background'
  executorTool?: ExecutorTool
  nestedCallId: string
  jobId?: string
  startedAt: string
  durationMs: number
  outcome: ExecutionOutcome
  exitCode?: number
}
```

Map JobSnapshot status/detail into the receipt without copying labels or output. Keep fixed command quoting and expose `workdirFor(task, sessionCwd)` through the plugin adapter rather than embedding paths in receipts.

- [ ] **Step 4: Run execution helper tests and verify GREEN**

Run: `pnpm vitest run tests/task-execution.spec.ts`

Expected: all helper tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/task-execution.ts tests/task-execution.spec.ts package.json pnpm-lock.yaml
git commit -m "feat: add background execution receipts"
```

### Task 4: Stateless verification gate

**Files:**
- Create: `src/verification-gate.ts`
- Create: `tests/verification-gate.spec.ts`

- [ ] **Step 1: Write failing verification tests**

Cover passed, pending, failed, stale plan, stale manifest, duplicate receipt, irrelevant receipt, and output-free result shapes.

```ts
expect(evaluateVerificationGate(plan, tasks, receipts)).toEqual({
  gateVersion: 1,
  verdict: 'passed',
  planDigest: plan.planDigest,
  requiredTaskIds: ['package:test'],
  missingTaskIds: [],
  runningTaskIds: [],
  failedTaskIds: [],
  staleTaskIds: [],
  reasonCodes: [],
})
```

- [ ] **Step 2: Run gate tests and verify RED**

Run: `pnpm vitest run tests/verification-gate.spec.ts`

Expected: FAIL because `evaluateVerificationGate` is missing.

- [ ] **Step 3: Implement deterministic gate evaluation**

Validate every receipt is version 2 and use the newest receipt per required task by `startedAt`, breaking exact ties deterministically. Check the caller-supplied plan digest against the freshly recomputed plan before evaluating outcomes. Return bounded task-ID arrays and reason codes only.

- [ ] **Step 4: Run gate tests and verify GREEN**

Run: `pnpm vitest run tests/verification-gate.spec.ts`

Expected: all gate tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/verification-gate.ts tests/verification-gate.spec.ts
git commit -m "feat: add deterministic verification gate"
```

### Task 5: Register the six-tool product surface

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/plugin.spec.ts`

- [ ] **Step 1: Write failing plugin integration tests**

Load `JobsLocal`, attach a test controller, and prove exact six-tool registration, workspace list/plan schema, auto-mode short completion, auto-mode running return, explicit background refusal when the visible shell lacks the capability, caller-fenced collection, gate success, stale digest rejection, and disposal.

```ts
expect(names).toEqual([
  'missher_project_ops_task_list',
  'missher_project_ops_task_plan',
  'missher_project_ops_task_run',
  'missher_project_ops_task_collect',
  'missher_project_ops_verification_gate',
  'missher_project_ops_capability_search',
])
```

- [ ] **Step 2: Run plugin tests and verify RED**

Run: `pnpm vitest run tests/plugin.spec.ts`

Expected: FAIL because four new/changed behaviors are absent.

- [ ] **Step 3: Implement tool adapters**

Update `inject` to `['fs', 'tools', 'jobs']`. Extend the filesystem reader with stable direct-directory listing and symlink rejection. Add JSON schemas and handlers for plan, collect, and gate. For `auto`, inspect the visible shell schema for `run_in_background`, nested-dispatch once with `run_in_background: true`, wait 1-10000 ms through `ctx.jobs`, read once only after the wait, and never rerun a started job. Fall back to existing foreground dispatch only before background start when auto capability is absent.

- [ ] **Step 4: Run plugin tests and verify GREEN**

Run: `pnpm vitest run tests/plugin.spec.ts`

Expected: all plugin integration tests pass.

- [ ] **Step 5: Run the full unit suite**

Run: `pnpm test`

Expected: all test files pass with zero failures.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts tests/plugin.spec.ts
git commit -m "feat: expose execution autopilot tools"
```

### Task 6: Package, documentation, smoke, and release evidence

**Files:**
- Modify: `package.json`
- Modify: `tests/package.spec.ts`
- Modify: `scripts/smoke.mjs`
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `README.i18n.yaml`
- Modify: `PROJECT_CONTEXT.md`
- Modify: `SECURITY.md`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Write failing package assertions**

Expect version `0.2.0`, six namespaced tools in the built integration surface, the Jobs peer, and updated smoke acceptance wording.

- [ ] **Step 2: Run package tests and verify RED**

Run: `pnpm vitest run tests/package.spec.ts`

Expected: FAIL on version and Jobs peer assertions.

- [ ] **Step 3: Update package and product documentation**

Bump to `0.2.0`; document the six tools, bounded workspace grammar, auto/background semantics, verification verdicts, compatibility boundary, one-command install URL, and upgrade/remove commands. Record the 0.2 architecture and remaining limitations in `PROJECT_CONTEXT.md`.

- [ ] **Step 4: Expand isolated lifecycle smoke**

Make the temporary workspace contain two local packages. Exercise list, affected plan, auto execution, terminal/running collection as supported by the fake Jobs runtime, and a passed verification gate. Keep the exact archive whitelist, secret scan, temporary `DSH_HOME`, install/compose/remove checks, and live-home sentinel.

- [ ] **Step 5: Run complete verification**

Run:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
pnpm run smoke:package
```

Expected: every command exits 0, all tests pass, and smoke prints its PASS lifecycle line.

- [ ] **Step 6: Commit release candidate**

```bash
git add package.json pnpm-lock.yaml tests/package.spec.ts scripts/smoke.mjs README.md README.zh.md README.i18n.yaml PROJECT_CONTEXT.md SECURITY.md .github/workflows/ci.yml
git commit -m "release: prepare dsh-project-ops 0.2.0"
```

- [ ] **Step 7: Finish, merge, publish, and verify public bytes**

Use `superpowers:finishing-a-development-branch`, merge the verified feature branch to `main`, create canonical `dsh-project-ops-0.2.0.tgz` and LF-only `SHA256SUMS`, push `main` and tag `v0.2.0`, create the GitHub Release without changing the existing release, download both public assets to a fresh temporary directory, and verify exact size and SHA-256 equality.
