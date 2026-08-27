import { createHash } from 'node:crypto'
import type {
  DiscoveryDiagnostic,
  ProjectTask,
  TaskDiscoveryResult,
  TaskInvocation,
  TaskSource,
} from './contracts.ts'

type PackageManager = Extract<TaskInvocation, { kind: 'package' }>['manager']

export const MAX_MANIFEST_BYTES = 1024 * 1024
export const MAX_TASKS = 128

/** Read exact project-root task candidates without exposing arbitrary paths. */
export interface ManifestReader {
  readCandidate(name: string, signal?: AbortSignal): Promise<Uint8Array | undefined>
  lockfiles(signal?: AbortSignal): Promise<readonly string[]>
}

interface ManifestContent {
  bytes: Uint8Array
  digest: string
  name: string
  text: string
}

const decoder = new TextDecoder('utf-8', { fatal: true })
const SOURCE_ORDER: Record<TaskSource, number> = { package: 0, make: 1, just: 2 }

function diagnostic(source: DiscoveryDiagnostic['source'], code: string, message: string): DiscoveryDiagnostic {
  return { source, code, message }
}

async function readFirst(
  reader: ManifestReader,
  source: TaskSource,
  names: readonly string[],
  diagnostics: DiscoveryDiagnostic[],
  signal?: AbortSignal,
): Promise<ManifestContent | undefined> {
  for (const name of names) {
    signal?.throwIfAborted()
    let bytes: Uint8Array | undefined
    try {
      bytes = await reader.readCandidate(name, signal)
    } catch {
      diagnostics.push(diagnostic(source, 'manifest-read-failed', `Could not read ${name}.`))
      return undefined
    }
    if (bytes === undefined) continue
    if (bytes.byteLength > MAX_MANIFEST_BYTES) {
      diagnostics.push(diagnostic(source, 'manifest-too-large', `${name} exceeds the 1 MiB discovery limit.`))
      return undefined
    }
    try {
      return {
        bytes,
        digest: createHash('sha256').update(bytes).digest('hex'),
        name,
        text: decoder.decode(bytes),
      }
    } catch {
      diagnostics.push(diagnostic(source, 'invalid-manifest', `${name} is not valid UTF-8 text.`))
      return undefined
    }
  }
  return undefined
}

function packageManagerFromField(value: unknown): PackageManager | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(npm|pnpm|yarn|bun)@/.exec(value.trim())
  return match?.[1] as PackageManager | undefined
}

function packageManagerFromLocks(lockfiles: readonly string[]): PackageManager | 'ambiguous' | undefined {
  const managers = new Set<PackageManager>()
  for (const name of lockfiles) {
    if (name === 'pnpm-lock.yaml') managers.add('pnpm')
    if (name === 'package-lock.json' || name === 'npm-shrinkwrap.json') managers.add('npm')
    if (name === 'yarn.lock') managers.add('yarn')
    if (name === 'bun.lock' || name === 'bun.lockb') managers.add('bun')
  }
  if (managers.size > 1) return 'ambiguous'
  return [...managers][0]
}

async function packageTasks(
  manifest: ManifestContent,
  reader: ManifestReader,
  diagnostics: DiscoveryDiagnostic[],
  signal?: AbortSignal,
): Promise<ProjectTask[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(manifest.text)
  } catch {
    diagnostics.push(diagnostic('package', 'invalid-manifest', 'package.json is not valid JSON.'))
    return []
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    diagnostics.push(diagnostic('package', 'invalid-manifest', 'package.json must contain an object.'))
    return []
  }
  const record = parsed as Record<string, unknown>
  const scripts = record.scripts
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return []

  let manager = packageManagerFromField(record.packageManager)
  if (record.packageManager !== undefined && manager === undefined) {
    diagnostics.push(diagnostic('package', 'unsupported-package-manager', 'packageManager does not name npm, pnpm, yarn, or bun.'))
  }
  if (manager === undefined) {
    let selected: ReturnType<typeof packageManagerFromLocks>
    try {
      selected = packageManagerFromLocks(await reader.lockfiles(signal))
    } catch {
      diagnostics.push(diagnostic('package', 'lockfile-read-failed', 'Could not inspect project lockfiles.'))
      selected = undefined
    }
    if (selected === 'ambiguous') {
      diagnostics.push(diagnostic('package', 'ambiguous-package-manager', 'Multiple package-manager lockfiles are present.'))
    } else {
      manager = selected
    }
  }
  if (manager === undefined && !diagnostics.some(row => row.source === 'package')) {
    diagnostics.push(diagnostic('package', 'package-manager-unavailable', 'No packageManager field or unambiguous lockfile selects a runner.'))
  }

  const tasks: ProjectTask[] = []
  for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof command !== 'string' || name.trim() === '') continue
    tasks.push({
      id: `package:${name}`,
      name,
      description: `Run package script ${JSON.stringify(name)}.`,
      source: 'package',
      manifest: manifest.name,
      manifestDigest: manifest.digest,
      runnable: manager !== undefined,
      ...manager === undefined ? {} : { invocation: { kind: 'package' as const, manager, script: name } },
    })
  }
  return tasks
}

function makeTasks(manifest: ManifestContent): ProjectTask[] {
  const lines = manifest.text.replaceAll('\r\n', '\n').split('\n')
  const names = new Set<string>()
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index]!
    if (/^\s/.test(line) || line.includes(':=') || line.includes('::')) continue
    const separator = line.indexOf(':')
    if (separator <= 0 || !/^\t/.test(lines[index + 1]!)) continue
    for (const target of line.slice(0, separator).trim().split(/\s+/)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target) || target.includes('%') || target.startsWith('.')) continue
      names.add(target)
    }
  }
  return [...names].map(name => ({
    id: `make:${name}`,
    name,
    description: `Run Make target ${JSON.stringify(name)}.`,
    source: 'make',
    manifest: manifest.name,
    manifestDigest: manifest.digest,
    runnable: true,
    invocation: { kind: 'make', target: name },
  }))
}

function justTasks(manifest: ManifestContent): ProjectTask[] {
  const lines = manifest.text.replaceAll('\r\n', '\n').split('\n')
  const names = new Set<string>()
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index]!
    if (/^\s/.test(line) || line.startsWith('@')) continue
    const match = /^([A-Za-z][A-Za-z0-9_-]*)([^:]*)\s*:/.exec(line)
    if (match === null || match[2]!.trim() !== '' || !/^\s+\S/.test(lines[index + 1]!)) continue
    const name = match[1]!
    if (name.startsWith('_')) continue
    names.add(name)
  }
  return [...names].map(name => ({
    id: `just:${name}`,
    name,
    description: `Run Just recipe ${JSON.stringify(name)}.`,
    source: 'just',
    manifest: manifest.name,
    manifestDigest: manifest.digest,
    runnable: true,
    invocation: { kind: 'just', recipe: name },
  }))
}

/** Discover bounded task declarations from exact project-root candidates. */
export async function discoverProjectTasks(
  reader: ManifestReader,
  signal?: AbortSignal,
): Promise<TaskDiscoveryResult> {
  const diagnostics: DiscoveryDiagnostic[] = []
  const tasks: ProjectTask[] = []
  const packageManifest = await readFirst(reader, 'package', ['package.json'], diagnostics, signal)
  if (packageManifest !== undefined) tasks.push(...await packageTasks(packageManifest, reader, diagnostics, signal))
  const makeManifest = await readFirst(reader, 'make', ['GNUmakefile', 'makefile', 'Makefile'], diagnostics, signal)
  if (makeManifest !== undefined) tasks.push(...makeTasks(makeManifest))
  const justManifest = await readFirst(reader, 'just', ['justfile', 'Justfile'], diagnostics, signal)
  if (justManifest !== undefined) tasks.push(...justTasks(justManifest))

  tasks.sort((left, right) => SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source]
    || left.id.localeCompare(right.id, 'en'))
  if (tasks.length > MAX_TASKS) {
    tasks.length = MAX_TASKS
    diagnostics.push(diagnostic('all', 'task-limit', `Task discovery returned the first ${MAX_TASKS} declarations.`))
  }
  return { tasks, diagnostics }
}
