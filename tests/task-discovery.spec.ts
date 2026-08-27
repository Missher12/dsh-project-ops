import { describe, expect, test } from 'vitest'
import {
  MAX_MANIFEST_BYTES,
  MAX_TASKS,
  discoverProjectTasks,
  type ManifestReader,
} from '../src/task-discovery.ts'

const encoder = new TextEncoder()

function reader(files: Record<string, string | Uint8Array>): ManifestReader {
  return {
    async readCandidate(name) {
      const value = files[name]
      if (value === undefined) return undefined
      return typeof value === 'string' ? encoder.encode(value) : value
    },
    async lockfiles() {
      return Object.keys(files).filter(name => [
        'pnpm-lock.yaml',
        'package-lock.json',
        'npm-shrinkwrap.json',
        'yarn.lock',
        'bun.lock',
        'bun.lockb',
      ].includes(name))
    },
  }
}

describe('project task discovery', () => {
  test('discovers declared package, Make, and Just tasks in stable order', async () => {
    const result = await discoverProjectTasks(reader({
      'package.json': JSON.stringify({ packageManager: 'pnpm@11.7.0', scripts: { test: 'vitest', build: 'tsc' } }),
      Makefile: 'build:\n\ttool build\npattern-%:\n\ttool pattern\n',
      justfile: 'check:\n  tool check\nwith-arg value:\n  tool {{value}}\n_private:\n  tool private\n',
    }))

    expect(result.tasks.map(task => task.id)).toEqual([
      'package:build',
      'package:test',
      'make:build',
      'just:check',
    ])
    expect(result.tasks.every(task => /^[a-f0-9]{64}$/.test(task.manifestDigest))).toBe(true)
    expect(result.diagnostics).toEqual([])
  })

  test('changes a task digest when its owning manifest changes', async () => {
    const first = await discoverProjectTasks(reader({
      'package.json': JSON.stringify({ packageManager: 'npm@11.0.0', scripts: { test: 'one' } }),
    }))
    const second = await discoverProjectTasks(reader({
      'package.json': JSON.stringify({ packageManager: 'npm@11.0.0', scripts: { test: 'two' } }),
    }))

    expect(first.tasks[0]?.id).toBe(second.tasks[0]?.id)
    expect(first.tasks[0]?.manifestDigest).not.toBe(second.tasks[0]?.manifestDigest)
  })

  test('keeps package tasks non-runnable when lockfiles select multiple managers', async () => {
    const result = await discoverProjectTasks(reader({
      'package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
      'pnpm-lock.yaml': '',
      'package-lock.json': '{}',
    }))

    expect(result.tasks).toMatchObject([{
      id: 'package:test',
      runnable: false,
    }])
    expect(result.tasks[0]?.invocation).toBeUndefined()
    expect(result.diagnostics).toMatchObject([{
      source: 'package',
      code: 'ambiguous-package-manager',
    }])
  })

  test('contains malformed and oversized manifests without exposing their contents', async () => {
    const malformed = await discoverProjectTasks(reader({ 'package.json': '{secret-value' }))
    const oversized = await discoverProjectTasks(reader({
      Makefile: new Uint8Array(MAX_MANIFEST_BYTES + 1).fill(65),
    }))

    expect(malformed.tasks).toEqual([])
    expect(malformed.diagnostics[0]).toMatchObject({ source: 'package', code: 'invalid-manifest' })
    expect(JSON.stringify(malformed.diagnostics)).not.toContain('secret-value')
    expect(oversized.diagnostics[0]).toMatchObject({ source: 'make', code: 'manifest-too-large' })
  })

  test('caps the complete result deterministically', async () => {
    const scripts = Object.fromEntries(
      Array.from({ length: MAX_TASKS + 10 }, (_, index) => [`task-${String(index).padStart(3, '0')}`, 'true']),
    )
    const result = await discoverProjectTasks(reader({
      'package.json': JSON.stringify({ packageManager: 'npm@11.0.0', scripts }),
      Makefile: 'build:\n\ttrue\n',
    }))

    expect(result.tasks).toHaveLength(MAX_TASKS)
    expect(result.tasks[0]?.id).toBe('package:task-000')
    expect(result.tasks.at(-1)?.id).toBe(`package:task-${MAX_TASKS - 1}`)
    expect(result.diagnostics).toContainEqual({
      source: 'all',
      code: 'task-limit',
      message: `Task discovery returned the first ${MAX_TASKS} declarations.`,
    })
  })
})
