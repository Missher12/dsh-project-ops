import { createHash } from 'node:crypto'
import type {
  DiscoveryDiagnostic,
  ProjectTask,
  TaskDiscoveryResult,
  TaskInvocation,
  TaskPurpose,
  TaskSource,
} from './contracts.ts'

type PackageManager = Extract<TaskInvocation, { kind: 'package' }>['manager']

export const MAX_MANIFEST_BYTES = 1024 * 1024
export const MAX_TASKS = 256
export const MAX_WORKSPACES = 64
export const MAX_WORKSPACE_DIRECTORIES = 256
export const MAX_WORKSPACE_DEPTH = 8

/** Read bounded task candidates and stable directory names below the project root. */
export interface ManifestReader {
  readCandidate(name: string, signal?: AbortSignal): Promise<Uint8Array | undefined>
  lockfiles(signal?: AbortSignal): Promise<readonly string[]>
  listDirectories(path: string, signal?: AbortSignal): Promise<readonly string[]>
}

interface ManifestContent {
  bytes: Uint8Array
  digest: string
  name: string
  text: string
}

interface ParsedPackage {
  dependencies: string[]
  manager?: PackageManager
  manifest: ManifestContent
  name?: string
  record: Record<string, unknown>
  workspace: string
}

const decoder = new TextDecoder('utf-8', { fatal: true })
const SOURCE_ORDER: Record<TaskSource, number> = { package: 0, make: 1, just: 2 }
const PACKAGE_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

function diagnostic(source: DiscoveryDiagnostic['source'], code: string, message: string): DiscoveryDiagnostic {
  return { source, code, message }
}

async function readManifest(
  reader: ManifestReader,
  source: TaskSource,
  name: string,
  diagnostics: DiscoveryDiagnostic[],
  signal?: AbortSignal,
): Promise<ManifestContent | undefined> {
  signal?.throwIfAborted()
  let bytes: Uint8Array | undefined
  try {
    bytes = await reader.readCandidate(name, signal)
  } catch {
    diagnostics.push(diagnostic(source, 'manifest-read-failed', `Could not read ${name.split('/').at(-1) ?? 'manifest'}.`))
    return undefined
  }
  if (bytes === undefined) return undefined
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    diagnostics.push(diagnostic(source, 'manifest-too-large', `${name.split('/').at(-1) ?? 'Manifest'} exceeds the 1 MiB discovery limit.`))
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
    diagnostics.push(diagnostic(source, 'invalid-manifest', `${name.split('/').at(-1) ?? 'Manifest'} is not valid UTF-8 text.`))
    return undefined
  }
}

async function readFirst(
  reader: ManifestReader,
  source: TaskSource,
  names: readonly string[],
  diagnostics: DiscoveryDiagnostic[],
  signal?: AbortSignal,
): Promise<ManifestContent | undefined> {
  for (const name of names) {
    const manifest = await readManifest(reader, source, name, diagnostics, signal)
    if (manifest !== undefined) return manifest
  }
  return undefined
}

function packageManagerFromField(value: unknown): PackageManager | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(npm|pnpm|yarn|bun)@/u.exec(value.trim())
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

function taskPurpose(name: string): TaskPurpose {
  const normalized = name.toLowerCase()
  const tokens = normalized.split(/[:._-]+/u)
  if (normalized.includes('typecheck') || normalized.includes('type-check')
    || (tokens.includes('type') && tokens.includes('check'))) return 'typecheck'
  if (tokens.includes('lint') || tokens.includes('eslint')) return 'lint'
  if (tokens.some(token => ['test', 'tests', 'spec', 'check', 'verify'].includes(token))) return 'test'
  if (tokens.some(token => ['build', 'compile', 'bundle', 'package'].includes(token))) return 'build'
  if (tokens.some(token => ['format', 'fmt', 'prettier'].includes(token))) return 'format'
  return 'other'
}

function parsePackage(manifest: ManifestContent, workspace: string, diagnostics: DiscoveryDiagnostic[]): ParsedPackage | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(manifest.text)
  } catch {
    diagnostics.push(diagnostic('package', 'invalid-manifest', `${manifest.name} is not valid JSON.`))
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    diagnostics.push(diagnostic('package', 'invalid-manifest', `${manifest.name} must contain an object.`))
    return undefined
  }
  const record = parsed as Record<string, unknown>
  const dependencies = new Set<string>()
  for (const field of PACKAGE_FIELDS) {
    const value = record[field]
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    for (const name of Object.keys(value)) dependencies.add(name)
  }
  const manager = packageManagerFromField(record.packageManager)
  if (record.packageManager !== undefined && manager === undefined) {
    diagnostics.push(diagnostic('package', 'unsupported-package-manager', 'packageManager does not name npm, pnpm, yarn, or bun.'))
  }
  return {
    dependencies: [...dependencies].sort((left, right) => left.localeCompare(right, 'en')),
    ...manager === undefined ? {} : { manager },
    manifest,
    ...typeof record.name === 'string' && record.name.trim() !== '' ? { name: record.name } : {},
    record,
    workspace,
  }
}

function packageTasks(pkg: ParsedPackage, inheritedManager: PackageManager | undefined): ProjectTask[] {
  const scripts = pkg.record.scripts
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return []
  const manager = pkg.manager ?? inheritedManager
  return Object.entries(scripts as Record<string, unknown>).flatMap(([name, command]): ProjectTask[] => {
    if (typeof command !== 'string' || name.trim() === '') return []
    return [{
      id: pkg.workspace === '.' ? `package:${name}` : `package@${pkg.workspace}:${name}`,
      name,
      description: pkg.workspace === '.'
        ? `Run package script ${JSON.stringify(name)}.`
        : `Run package script ${JSON.stringify(name)} in workspace ${JSON.stringify(pkg.workspace)}.`,
      source: 'package',
      manifest: pkg.manifest.name,
      manifestDigest: pkg.manifest.digest,
      workspace: pkg.workspace,
      ...pkg.name === undefined ? {} : { packageName: pkg.name },
      purpose: taskPurpose(name),
      dependsOn: [],
      runnable: manager !== undefined,
      ...manager === undefined ? {} : {
        invocation: { kind: 'package' as const, manager, script: name, cwd: pkg.workspace },
      },
    }]
  })
}

function workspacePatternsFromPackage(record: Record<string, unknown>): string[] {
  const workspaces = record.workspaces
  if (Array.isArray(workspaces)) return workspaces.filter((value): value is string => typeof value === 'string')
  if (typeof workspaces !== 'object' || workspaces === null) return []
  const packages = (workspaces as Record<string, unknown>).packages
  return Array.isArray(packages) ? packages.filter((value): value is string => typeof value === 'string') : []
}

function workspacePatternsFromPnpm(text: string): string[] {
  const patterns: string[] = []
  let inPackages = false
  for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
    if (/^packages\s*:\s*$/u.test(line)) {
      inPackages = true
      continue
    }
    if (!inPackages) continue
    if (/^[^\s#]/u.test(line)) break
    const match = /^\s*-\s*(.+?)\s*$/u.exec(line)
    if (match === null) continue
    let value = match[1]!
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1)
    }
    patterns.push(value)
  }
  return patterns
}

function patternSegments(pattern: string): string[] | undefined {
  if (pattern.trim() !== pattern || pattern === '' || pattern.startsWith('/') || pattern.startsWith('!')
    || pattern.includes('\\') || pattern.includes('//') || /^[A-Za-z]:/u.test(pattern)) return undefined
  const segments = pattern.split('/')
  if (segments.length > MAX_WORKSPACE_DEPTH || segments.some(segment => segment === '' || segment === '..')) return undefined
  for (const [index, segment] of segments.entries()) {
    if (segment === '*') continue
    if (segment === '**' && index === segments.length - 1) continue
    if (!/^[A-Za-z0-9@._-]+$/u.test(segment)) return undefined
  }
  return segments
}

async function workspaceDirectories(
  reader: ManifestReader,
  patterns: readonly string[],
  diagnostics: DiscoveryDiagnostic[],
  signal?: AbortSignal,
): Promise<string[]> {
  const matches = new Set<string>()
  const visited = new Set<string>()
  let directoryLimit = false

  async function children(path: string): Promise<readonly string[]> {
    signal?.throwIfAborted()
    if (visited.size >= MAX_WORKSPACE_DIRECTORIES) {
      directoryLimit = true
      return []
    }
    visited.add(path)
    try {
      return await reader.listDirectories(path, signal)
    } catch {
      diagnostics.push(diagnostic('package', 'workspace-read-failed', 'Could not inspect workspace directories.'))
      return []
    }
  }

  async function expand(path: string, segments: readonly string[], index: number): Promise<void> {
    if (index === segments.length) {
      if (path !== '.') matches.add(path)
      return
    }
    const segment = segments[index]!
    const names = await children(path)
    if (segment === '**') {
      if (path !== '.') matches.add(path)
      for (const name of names) {
        const next = path === '.' ? name : `${path}/${name}`
        matches.add(next)
        if (next.split('/').length < MAX_WORKSPACE_DEPTH) await expand(next, segments, index)
      }
      return
    }
    const selected = segment === '*' ? names : names.filter(name => name === segment)
    for (const name of selected) {
      const next = path === '.' ? name : `${path}/${name}`
      await expand(next, segments, index + 1)
    }
  }

  for (const pattern of patterns) {
    const segments = patternSegments(pattern)
    if (segments === undefined) {
      diagnostics.push(diagnostic('package', 'unsupported-workspace-pattern', 'Ignored unsupported workspace pattern.'))
      continue
    }
    await expand('.', segments, 0)
  }
  if (directoryLimit) {
    diagnostics.push(diagnostic('package', 'workspace-directory-limit', `Workspace traversal inspected at most ${MAX_WORKSPACE_DIRECTORIES} directories.`))
  }
  const sorted = [...matches].sort((left, right) => left.localeCompare(right, 'en'))
  if (sorted.length > MAX_WORKSPACES) {
    sorted.length = MAX_WORKSPACES
    diagnostics.push(diagnostic('package', 'workspace-limit', `Workspace discovery returned the first ${MAX_WORKSPACES} package directories.`))
  }
  return sorted
}

function linkPackageDependencies(tasks: ProjectTask[], packages: readonly ParsedPackage[]): void {
  const byName = new Map(packages.flatMap(pkg => pkg.name === undefined ? [] : [[pkg.name, pkg] as const]))
  const tasksByWorkspace = new Map<string, ProjectTask[]>()
  for (const task of tasks) {
    const existing = tasksByWorkspace.get(task.workspace) ?? []
    existing.push(task)
    tasksByWorkspace.set(task.workspace, existing)
  }
  for (const pkg of packages) {
    const ownTasks = tasksByWorkspace.get(pkg.workspace) ?? []
    for (const own of ownTasks) {
      const dependencies = pkg.dependencies.flatMap(name => {
        const dependency = byName.get(name)
        if (dependency === undefined) return []
        return (tasksByWorkspace.get(dependency.workspace) ?? [])
          .filter(candidate => candidate.purpose === own.purpose)
          .map(candidate => candidate.id)
      })
      own.dependsOn = [...new Set(dependencies)].sort((left, right) => left.localeCompare(right, 'en'))
    }
  }
}

function makeTasks(manifest: ManifestContent): ProjectTask[] {
  const lines = manifest.text.replaceAll('\r\n', '\n').split('\n')
  const names = new Set<string>()
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index]!
    if (/^\s/u.test(line) || line.includes(':=') || line.includes('::')) continue
    const separator = line.indexOf(':')
    if (separator <= 0 || !/^\t/u.test(lines[index + 1]!)) continue
    for (const target of line.slice(0, separator).trim().split(/\s+/u)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(target) || target.includes('%') || target.startsWith('.')) continue
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
    workspace: '.',
    purpose: taskPurpose(name),
    dependsOn: [],
    runnable: true,
    invocation: { kind: 'make', target: name },
  }))
}

function justTasks(manifest: ManifestContent): ProjectTask[] {
  const lines = manifest.text.replaceAll('\r\n', '\n').split('\n')
  const names = new Set<string>()
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index]!
    if (/^\s/u.test(line) || line.startsWith('@')) continue
    const match = /^([A-Za-z][A-Za-z0-9_-]*)([^:]*)\s*:/u.exec(line)
    if (match === null || match[2]!.trim() !== '' || !/^\s+\S/u.test(lines[index + 1]!)) continue
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
    workspace: '.',
    purpose: taskPurpose(name),
    dependsOn: [],
    runnable: true,
    invocation: { kind: 'just', recipe: name },
  }))
}

/** Discover bounded task declarations from the root and declared package workspaces. */
export async function discoverProjectTasks(
  reader: ManifestReader,
  signal?: AbortSignal,
): Promise<TaskDiscoveryResult> {
  const diagnostics: DiscoveryDiagnostic[] = []
  const tasks: ProjectTask[] = []
  const packages: ParsedPackage[] = []
  const rootManifest = await readManifest(reader, 'package', 'package.json', diagnostics, signal)
  const rootPackage = rootManifest === undefined ? undefined : parsePackage(rootManifest, '.', diagnostics)

  let rootManager = rootPackage?.manager
  if (rootPackage !== undefined && rootManager === undefined) {
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
      rootManager = selected
    }
    if (rootManager === undefined && !diagnostics.some(row => row.source === 'package')) {
      diagnostics.push(diagnostic('package', 'package-manager-unavailable', 'No packageManager field or unambiguous lockfile selects a runner.'))
    }
  }

  if (rootPackage !== undefined) {
    packages.push(rootPackage)
    tasks.push(...packageTasks(rootPackage, rootManager))
    const pnpmWorkspace = await readManifest(reader, 'package', 'pnpm-workspace.yaml', diagnostics, signal)
    const patterns = [
      ...workspacePatternsFromPackage(rootPackage.record),
      ...pnpmWorkspace === undefined ? [] : workspacePatternsFromPnpm(pnpmWorkspace.text),
    ]
    const directories = await workspaceDirectories(reader, [...new Set(patterns)], diagnostics, signal)
    for (const workspace of directories) {
      const manifest = await readManifest(reader, 'package', `${workspace}/package.json`, diagnostics, signal)
      if (manifest === undefined) continue
      const pkg = parsePackage(manifest, workspace, diagnostics)
      if (pkg === undefined) continue
      packages.push(pkg)
      tasks.push(...packageTasks(pkg, rootManager))
    }
  }

  linkPackageDependencies(tasks, packages)
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
