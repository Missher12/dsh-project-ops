import { describe, expect, test } from 'vitest'
import type { ProjectTask, TaskPurpose } from '../src/contracts.ts'
import { createTaskPlan } from '../src/task-planning.ts'

function task(
  id: string,
  workspace: string,
  purpose: TaskPurpose,
  dependsOn: string[] = [],
): ProjectTask {
  return {
    id,
    name: id.split(':').at(-1) ?? id,
    description: id,
    source: 'package',
    manifest: workspace === '.' ? 'package.json' : `${workspace}/package.json`,
    manifestDigest: id.padEnd(64, 'a').slice(0, 64).replaceAll(/[^a-f0-9]/gu, 'a'),
    workspace,
    purpose,
    dependsOn,
    runnable: true,
    invocation: { kind: 'package', manager: 'pnpm', script: purpose, cwd: workspace },
  }
}

const tasks: ProjectTask[] = [
  task('package:test', '.', 'test'),
  task('package:build', '.', 'build'),
  task('package@packages/a:test', 'packages/a', 'test'),
  task('package@packages/a:build', 'packages/a', 'build'),
  task('package@packages/b:test', 'packages/b', 'test', ['package@packages/a:test']),
  task('package@packages/b:lint', 'packages/b', 'lint'),
  task('package@packages/b:build', 'packages/b', 'build', ['package@packages/a:build']),
  task('package@packages/b:dev', 'packages/b', 'other'),
]

describe('affected task planning', () => {
  test('selects changed workspace checks, reverse dependents, dependencies, and root checks', () => {
    const plan = createTaskPlan(tasks, ['packages/a/src/index.ts'], 'verify')

    expect(plan.tasks.map(row => row.id)).toEqual([
      'package@packages/a:test',
      'package@packages/b:lint',
      'package@packages/b:test',
      'package:test',
    ])
    expect(plan.planVersion).toBe(1)
    expect(plan.changedFilesDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(plan.planDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(plan.affectedWorkspaces).toEqual(['packages/a', 'packages/b'])
    expect(plan.diagnostics).toEqual([])
  })

  test('treats a root change as affecting all workspaces and limits all to safe check purposes', () => {
    const plan = createTaskPlan(tasks, ['tsconfig.json'], 'all')

    expect(plan.tasks.map(row => row.id)).toEqual([
      'package@packages/a:build',
      'package@packages/a:test',
      'package@packages/b:build',
      'package@packages/b:lint',
      'package@packages/b:test',
      'package:build',
      'package:test',
    ])
    expect(plan.tasks.some(row => row.id.endsWith(':dev'))).toBe(false)
  })

  test('normalizes path separators, ordering, and duplicates before digesting', () => {
    const first = createTaskPlan(tasks, ['packages\\a\\src\\x.ts', 'packages/a/src/x.ts'], 'build')
    const second = createTaskPlan(tasks, ['packages/a/src/x.ts'], 'build')

    expect(first.changedFiles).toEqual(['packages/a/src/x.ts'])
    expect(first.changedFilesDigest).toBe(second.changedFilesDigest)
    expect(first.planDigest).toBe(second.planDigest)
  })

  test('rejects empty, absolute, escaping, NUL, oversized, and excessive paths', () => {
    expect(() => createTaskPlan(tasks, [], 'verify')).toThrow('changedFiles must contain 1 through 256 paths')
    expect(() => createTaskPlan(tasks, ['/etc/passwd'], 'verify')).toThrow('workspace-relative')
    expect(() => createTaskPlan(tasks, ['../outside'], 'verify')).toThrow('workspace-relative')
    expect(() => createTaskPlan(tasks, ['C:\\outside'], 'verify')).toThrow('workspace-relative')
    expect(() => createTaskPlan(tasks, ['a\0b'], 'verify')).toThrow('workspace-relative')
    expect(() => createTaskPlan(tasks, ['x'.repeat(513)], 'verify')).toThrow('at most 512 characters')
    expect(() => createTaskPlan(tasks, Array.from({ length: 257 }, (_, index) => `f-${index}`), 'verify'))
      .toThrow('changedFiles must contain 1 through 256 paths')
  })

  test('returns cyclic tasks in stable order with a bounded diagnostic', () => {
    const cyclic = [
      task('package@packages/a:test', 'packages/a', 'test', ['package@packages/b:test']),
      task('package@packages/b:test', 'packages/b', 'test', ['package@packages/a:test']),
    ]

    const plan = createTaskPlan(cyclic, ['packages/a/src/index.ts'], 'verify')

    expect(plan.tasks.map(row => row.id)).toEqual([
      'package@packages/a:test',
      'package@packages/b:test',
    ])
    expect(plan.diagnostics).toContainEqual({
      source: 'all',
      code: 'task-dependency-cycle',
      message: 'Affected tasks contain a dependency cycle; cyclic tasks use stable order.',
    })
  })

  test('changes the plan digest when goal, task manifest, or changed files change', () => {
    const base = createTaskPlan(tasks, ['packages/a/src/index.ts'], 'verify')
    const goal = createTaskPlan(tasks, ['packages/a/src/index.ts'], 'build')
    const manifest = createTaskPlan(tasks.map(row => row.id === 'package@packages/a:test'
      ? { ...row, manifestDigest: 'f'.repeat(64) }
      : row), ['packages/a/src/index.ts'], 'verify')
    const files = createTaskPlan(tasks, ['packages/b/src/index.ts'], 'verify')

    expect(new Set([base.planDigest, goal.planDigest, manifest.planDigest, files.planDigest])).toHaveLength(4)
  })
})
