import { describe, expect, test } from 'vitest'
import { rankCapabilities, type CapabilityCandidate } from '../src/capability-ranking.ts'

const rows: CapabilityCandidate[] = [
  { source: 'tool', id: 'tool:bash', name: 'bash', description: 'Run test commands and inspect files in a shell.' },
  { source: 'tool', id: 'tool:test_runner', name: 'test_runner', description: 'Execute a selected check.' },
  { source: 'project-task', id: 'package:test', name: 'test', description: 'Run package test.' },
  { source: 'tool', id: 'tool:files', name: 'files', description: 'Read project files.' },
]

describe('capability ranking', () => {
  test('ranks exact, name-token, and description matches deterministically', () => {
    expect(rankCapabilities('test', rows, 3).map(row => row.id)).toEqual([
      'package:test',
      'tool:test_runner',
      'tool:bash',
    ])
  })

  test('normalizes Unicode case and keeps stable source and id tie-breaking', () => {
    const tied: CapabilityCandidate[] = [
      { source: 'tool', id: 'tool:z', name: 'ＦＯＯ z', description: '' },
      { source: 'project-task', id: 'package:foo', name: 'foo task', description: '' },
      { source: 'tool', id: 'tool:a', name: 'foo a', description: '' },
    ]

    expect(rankCapabilities('foo', tied, 3).map(row => row.id)).toEqual([
      'package:foo',
      'tool:a',
      'tool:z',
    ])
  })

  test('omits zero-score rows and records a concise reason', () => {
    const matches = rankCapabilities('files', rows, 10)

    expect(matches).toHaveLength(2)
    expect(matches[0]).toMatchObject({ id: 'tool:files', reason: 'exact-name' })
    expect(matches[1]).toMatchObject({ id: 'tool:bash', reason: 'description-token' })
  })

  test('rejects blank, oversized, and out-of-range requests', () => {
    expect(() => rankCapabilities('  ', rows, 5)).toThrow('query must be nonblank')
    expect(() => rankCapabilities('x'.repeat(257), rows, 5)).toThrow('query must be at most 256 characters')
    expect(() => rankCapabilities('test', rows, 0)).toThrow('limit must be an integer from 1 through 10')
    expect(() => rankCapabilities('test', rows, 11)).toThrow('limit must be an integer from 1 through 10')
  })
})
