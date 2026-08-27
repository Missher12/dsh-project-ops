import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('Bundle package', () => {
  test('declares one isolated Bundle row', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      name: string
      dsh: { bundle: { patch: string } }
    }
    expect(manifest.name).toBe('dsh-project-ops')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8')).toBe(
      '- insert:\n    - id: missher-project-ops\n      name: dsh-project-ops\n',
    )
  })

  test('marks Host-provided runtime peers optional for Profile installation', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      version: string
      peerDependencies: Record<string, string>
      peerDependenciesMeta: Record<string, { optional?: boolean }>
    }
    expect(manifest.version).toBe('0.2.0')
    expect(manifest.peerDependencies['@deepseek-ai/dsh-jobs']).toBe('0.1.1-rc.2')
    expect(Object.keys(manifest.peerDependenciesMeta).sort()).toEqual(Object.keys(manifest.peerDependencies).sort())
    expect(Object.values(manifest.peerDependenciesMeta).every(meta => meta.optional === true)).toBe(true)
  })
})
