import { describe, expect, test } from 'vitest'
import type { ProjectTask } from '../src/contracts.ts'
import {
  commandFor,
  createReceipt,
  receiptContent,
  type ReceiptResult,
} from '../src/task-execution.ts'

function packageTask(script = 'build:site'): ProjectTask {
  return {
    id: `package:${script}`,
    name: script,
    description: 'Build the site.',
    source: 'package',
    manifest: 'package.json',
    manifestDigest: 'a'.repeat(64),
    runnable: true,
    invocation: { kind: 'package', manager: 'pnpm', script },
  }
}

function result(value: unknown, isError = false, code?: string): ReceiptResult {
  return isError
    ? { isError: true, content: [{ type: 'text', text: 'safe failure' }], error: { message: 'safe failure', info: code === undefined ? undefined : { name: 'Error', code } } }
    : { isError: false, content: [{ type: 'text', text: 'task output' }], value }
}

describe('task execution helpers', () => {
  test('constructs only fixed task commands with platform-correct quoting', () => {
    expect(commandFor(packageTask(), 'bash')).toBe("pnpm run 'build:site'")
    expect(commandFor(packageTask("quote's"), 'bash')).toBe("pnpm run 'quote'\\''s'")
    expect(commandFor(packageTask("quote's"), 'pwsh')).toBe("pnpm run 'quote''s'")
    expect(commandFor({ ...packageTask('x'), invocation: { kind: 'make', target: 'build' } }, 'bash')).toBe("make -- 'build'")
    expect(commandFor({ ...packageTask('x'), invocation: { kind: 'just', recipe: 'check' } }, 'pwsh')).toBe("just -- 'check'")
  })

  test('rejects a task without a rediscovered invocation', () => {
    expect(() => commandFor({ ...packageTask(), runnable: false, invocation: undefined }, 'bash'))
      .toThrow('task is not runnable')
  })

  test('projects success, failure, blocking, abort, and unavailability', () => {
    const base = {
      task: packageTask(),
      executorTool: 'bash' as const,
      nestedCallId: 'call:project-ops:1',
      startedAt: '2026-08-27T08:00:00.000Z',
      durationMs: 25,
    }
    const success = createReceipt({ ...base, result: result({ kind: 'foreground', exitCode: 0, cwd: '/private/project' }) })
    const failure = createReceipt({ ...base, result: result({ kind: 'foreground', exitCode: 2 }) })
    const blocked = createReceipt({ ...base, result: result({ kind: 'foreground', exitCode: 1, sandbox: { denied: true } }) })
    const aborted = createReceipt({ ...base, result: result(undefined, true, 'ABORTED') })
    const unavailable = createReceipt({ ...base, executorTool: undefined, result: undefined })

    expect(success).toMatchObject({ outcome: 'succeeded', exitCode: 0 })
    expect(failure).toMatchObject({ outcome: 'failed', exitCode: 2 })
    expect(blocked).toMatchObject({ outcome: 'blocked', exitCode: 1 })
    expect(aborted).toMatchObject({ outcome: 'aborted' })
    expect(unavailable).toMatchObject({ outcome: 'unavailable' })
    expect(JSON.stringify(success)).not.toContain('/private/project')
  })

  test('forwards nested content once and appends one JSON receipt block', () => {
    const receipt = createReceipt({
      task: packageTask(),
      executorTool: 'pwsh',
      nestedCallId: 'nested-1',
      startedAt: '2026-08-27T08:00:00.000Z',
      durationMs: 10,
      result: result('ok'),
    })
    const content = receiptContent([{ type: 'text', text: 'only once' }], receipt)

    expect(content).toHaveLength(2)
    expect(content[0]).toEqual({ type: 'text', text: 'only once' })
    expect(content[1]).toMatchObject({ type: 'text' })
    expect((content[1] as { text: string }).text).toContain('"receiptVersion": 1')
  })
})
