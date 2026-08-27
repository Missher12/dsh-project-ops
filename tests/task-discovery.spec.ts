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
    async listDirectories(path) {
      const prefix = path === '.' ? '' : `${path}/`
      const names = new Set<string>()
      for (const candidate of Object.keys(files)) {
        if (!candidate.startsWith(prefix)) continue
        const remainder = candidate.slice(prefix.length)
        const separator = remainder.indexOf('/')
        if (separator > 0) names.add(remainder.slice(0, separator))
      }
      return [...names].sort((left, right) => left.localeCompare(right, 'en'))
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

  test('discovers bounded package workspaces and links same-purpose dependency tasks', async () => {
    const result = await discoverProjectTasks(reader({
      'package.json': JSON.stringify({
        packageManager: 'pnpm@11.7.0',
        workspaces: ['packages/*'],
        scripts: { test: 'vitest' },
      }),
      'packages/a/package.json': JSON.stringify({
        name: '@acme/a',
        scripts: { build: 'tsc', test: 'vitest' },
      }),
      'packages/b/package.json': JSON.stringify({
        name: '@acme/b',
        dependencies: { '@acme/a': 'workspace:*' },
        scripts: { build: 'tsc', test: 'vitest', lint: 'eslint .', typecheck: 'tsc --noEmit' },
      }),
    }))

    expect(result.tasks.map(task => task.id)).toEqual([
      'package:test',
      'package@packages/a:build',
      'package@packages/a:test',
      'package@packages/b:build',
      'package@packages/b:lint',
      'package@packages/b:test',
      'package@packages/b:typecheck',
    ])
    expect(result.tasks.find(task => task.id === 'package@packages/b:build')).toMatchObject({
      workspace: 'packages/b',
      packageName: '@acme/b',
      purpose: 'build',
      dependsOn: ['package@packages/a:build'],
      invocation: { manager: 'pnpm', cwd: 'packages/b' },
    })
    expect(result.tasks.find(task => task.id === 'package@packages/b:test')).toMatchObject({
      purpose: 'test',
      dependsOn: ['package@packages/a:test'],
    })
    expect(result.tasks.find(task => task.id === 'package@packages/b:typecheck')).toMatchObject({ purpose: 'typecheck' })
    expect(result.diagnostics).toEqual([])
  })

  test('reads pnpm workspace packages and rejects escaping patterns without traversal', async () => {
    const result = await discoverProjectTasks(reader({
      'package.json': JSON.stringify({ packageManager: 'pnpm@11.7.0' }),
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - '../outside/*'\n",
      'apps/web/package.json': JSON.stringify({ name: '@acme/web', scripts: { build: 'vite build' } }),
      '../outside/secret/package.json': JSON.stringify({ name: 'secret', scripts: { leak: 'print-secret' } }),
    }))

    expect(result.tasks.map(task => task.id)).toEqual(['package@apps/web:build'])
    expect(result.diagnostics).toContainEqual({
      source: 'package',
      code: 'unsupported-workspace-pattern',
      message: 'Ignored unsupported workspace pattern.',
    })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  test('caps workspace expansion deterministically', async () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ packageManager: 'npm@11.0.0', workspaces: ['packages/*'] }),
    }
    for (let index = 0; index < 70; index += 1) {
      const name = `p-${String(index).padStart(2, '0')}`
      files[`packages/${name}/package.json`] = JSON.stringify({ name, scripts: { test: 'true' } })
    }

    const result = await discoverProjectTasks(reader(files))

    expect(result.tasks).toHaveLength(64)
    expect(result.tasks[0]?.id).toBe('package@packages/p-00:test')
    expect(result.tasks.at(-1)?.id).toBe('package@packages/p-63:test')
    expect(result.diagnostics).toContainEqual({
      source: 'package',
      code: 'workspace-limit',
      message: 'Workspace discovery returned the first 64 package directories.',
    })
  })
})
