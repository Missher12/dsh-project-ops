import { describe, expect, test } from 'vitest'
import type { ProjectTask } from '../src/contracts.ts'
import type { ExecutionOutcome, ExecutionReceipt } from '../src/task-execution.ts'
import { createTaskPlan } from '../src/task-planning.ts'
import { evaluateVerificationGate } from '../src/verification-gate.ts'

function task(id: string, workspace = '.'): ProjectTask {
  return {
    id,
    name: id,
    description: id,
    source: 'package',
    manifest: workspace === '.' ? 'package.json' : `${workspace}/package.json`,
    manifestDigest: 'a'.repeat(64),
    workspace,
    purpose: 'test',
    dependsOn: [],
    runnable: true,
    invocation: { kind: 'package', manager: 'pnpm', script: 'test', cwd: workspace },
  }
}

function receipt(row: ProjectTask, outcome: ExecutionOutcome, startedAt = '2026-08-28T01:00:00.000Z'): ExecutionReceipt {
  return {
    receiptVersion: 2,
    taskId: row.id,
    source: row.source,
    workspace: row.workspace,
    purpose: row.purpose,
    manifestDigest: row.manifestDigest,
    executionMode: 'foreground',
    executorTool: 'bash',
    nestedCallId: `call:${row.id}`,
    startedAt,
    durationMs: 20,
    outcome,
    ...outcome === 'succeeded' ? { exitCode: 0 } : {},
  }
}

describe('verification gate', () => {
  test('passes only when every required task has a fresh successful receipt', () => {
    const rows = [task('package@test:test', 'packages/test'), task('package:test')]
    const plan = createTaskPlan(rows, ['packages/test/src/index.ts'], 'verify')
    const gate = evaluateVerificationGate(plan, rows, rows.map(row => receipt(row, 'succeeded')))

    expect(gate).toEqual({
      gateVersion: 1,
      verdict: 'passed',
      planDigest: plan.planDigest,
      requiredTaskIds: ['package@test:test', 'package:test'],
      missingTaskIds: [],
      runningTaskIds: [],
      failedTaskIds: [],
      staleTaskIds: [],
      reasonCodes: [],
    })
  })

  test('returns pending for missing or running evidence', () => {
    const rows = [task('package@test:test', 'packages/test'), task('package:test')]
    const plan = createTaskPlan(rows, ['packages/test/src/index.ts'], 'verify')
    const gate = evaluateVerificationGate(plan, rows, [receipt(rows[0]!, 'running')])

    expect(gate).toMatchObject({
      verdict: 'pending',
      missingTaskIds: ['package:test'],
      runningTaskIds: ['package@test:test'],
      reasonCodes: ['missing-receipt', 'running-receipt'],
    })
  })

  test('fails for unsuccessful terminal evidence', () => {
    const rows = [task('package:test')]
    const plan = createTaskPlan(rows, ['src/index.ts'], 'verify')

    for (const outcome of ['failed', 'blocked', 'aborted', 'unavailable'] as const) {
      expect(evaluateVerificationGate(plan, rows, [receipt(rows[0]!, outcome)])).toMatchObject({
        verdict: 'failed',
        failedTaskIds: ['package:test'],
        reasonCodes: ['unsuccessful-receipt'],
      })
    }
  })

  test('marks changed plan, required task set, and manifest evidence stale', () => {
    const rows = [task('package:test')]
    const plan = createTaskPlan(rows, ['src/index.ts'], 'verify')
    const changed = [{ ...rows[0]!, manifestDigest: 'b'.repeat(64) }]

    expect(evaluateVerificationGate(plan, rows, [receipt(rows[0]!, 'succeeded')], 'f'.repeat(64))).toMatchObject({
      verdict: 'stale',
      reasonCodes: ['plan-digest-mismatch'],
    })
    expect(evaluateVerificationGate(plan, [], [], plan.planDigest)).toMatchObject({
      verdict: 'stale',
      staleTaskIds: ['package:test'],
      reasonCodes: ['task-set-changed'],
    })
    expect(evaluateVerificationGate(plan, changed, [receipt(rows[0]!, 'succeeded')], plan.planDigest)).toMatchObject({
      verdict: 'stale',
      staleTaskIds: ['package:test'],
      reasonCodes: ['manifest-changed'],
    })
  })

  test('uses the newest duplicate receipt and ignores irrelevant task evidence', () => {
    const rows = [task('package:test')]
    const plan = createTaskPlan(rows, ['src/index.ts'], 'verify')
    const irrelevant = receipt(task('package:other'), 'failed')
    const oldFailure = receipt(rows[0]!, 'failed', '2026-08-28T01:00:00.000Z')
    const newSuccess = receipt(rows[0]!, 'succeeded', '2026-08-28T01:01:00.000Z')

    expect(evaluateVerificationGate(plan, rows, [irrelevant, newSuccess, oldFailure])).toMatchObject({
      verdict: 'passed',
      failedTaskIds: [],
    })
  })

  test('never projects commands, output, paths, or receipt call metadata', () => {
    const rows = [task('package:test')]
    const plan = createTaskPlan(rows, ['private/source.ts'], 'verify')
    const gate = evaluateVerificationGate(plan, rows, [receipt(rows[0]!, 'succeeded')])
    const serialized = JSON.stringify(gate)

    expect(serialized).not.toContain('private/source.ts')
    expect(serialized).not.toContain('nestedCallId')
    expect(serialized).not.toContain('executorTool')
  })
})
