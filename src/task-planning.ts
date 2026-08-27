import { createHash } from 'node:crypto'
import type { DiscoveryDiagnostic, ProjectTask, TaskPurpose } from './contracts.ts'

export type PlanGoal = 'verify' | 'build' | 'all'

export interface TaskPlan {
  planVersion: 1
  goal: PlanGoal
  changedFiles: string[]
  changedFilesDigest: string
  planDigest: string
  affectedWorkspaces: string[]
  tasks: ProjectTask[]
  diagnostics: DiscoveryDiagnostic[]
}

const GOAL_PURPOSES: Record<PlanGoal, ReadonlySet<TaskPurpose>> = {
  verify: new Set(['test', 'lint', 'typecheck']),
  build: new Set(['build']),
  all: new Set(['test', 'lint', 'typecheck', 'build']),
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function normalizeChangedFiles(paths: readonly string[]): string[] {
  if (paths.length < 1 || paths.length > 256) throw new Error('changedFiles must contain 1 through 256 paths')
  const normalized = new Set<string>()
  for (const value of paths) {
    if (typeof value !== 'string' || [...value].length > 512) {
      throw new Error('each changed file path must be at most 512 characters')
    }
    if (value === '' || value.includes('\0') || /^[A-Za-z]:[\\/]/u.test(value)) {
      throw new Error('changed file paths must be workspace-relative')
    }
    const path = value.replaceAll('\\', '/')
    if (path.startsWith('/') || path.endsWith('/')) throw new Error('changed file paths must be workspace-relative')
    const segments = path.split('/').filter(segment => segment !== '.')
    if (segments.length === 0 || segments.some(segment => segment === '' || segment === '..')) {
      throw new Error('changed file paths must be workspace-relative')
    }
    normalized.add(segments.join('/'))
  }
  return [...normalized].sort((left, right) => left.localeCompare(right, 'en'))
}

function taskOrder(left: ProjectTask, right: ProjectTask): number {
  if (left.workspace === '.' && right.workspace !== '.') return 1
  if (left.workspace !== '.' && right.workspace === '.') return -1
  return left.id.localeCompare(right.id, 'en')
}

function affectedWorkspaces(tasks: readonly ProjectTask[], changedFiles: readonly string[]): string[] {
  const workspaces = [...new Set(tasks.map(task => task.workspace).filter(workspace => workspace !== '.'))]
    .sort((left, right) => right.length - left.length || left.localeCompare(right, 'en'))
  const affected = new Set<string>()
  let rootChange = false
  for (const file of changedFiles) {
    const workspace = workspaces.find(candidate => file === candidate || file.startsWith(`${candidate}/`))
    if (workspace === undefined) rootChange = true
    else affected.add(workspace)
  }
  if (rootChange) for (const workspace of workspaces) affected.add(workspace)

  const byId = new Map(tasks.map(task => [task.id, task] as const))
  let changed = true
  while (changed) {
    changed = false
    for (const task of tasks) {
      if (task.workspace === '.' || affected.has(task.workspace)) continue
      if (task.dependsOn.some(id => {
        const dependency = byId.get(id)
        return dependency !== undefined && dependency.workspace !== '.' && affected.has(dependency.workspace)
      })) {
        affected.add(task.workspace)
        changed = true
      }
    }
  }
  return [...affected].sort((left, right) => left.localeCompare(right, 'en'))
}

function dependencyClosure(initial: readonly ProjectTask[], tasks: readonly ProjectTask[]): ProjectTask[] {
  const byId = new Map(tasks.map(task => [task.id, task] as const))
  const selected = new Map(initial.map(task => [task.id, task] as const))
  const pending = [...initial]
  while (pending.length > 0) {
    const task = pending.pop()!
    for (const id of task.dependsOn) {
      const dependency = byId.get(id)
      if (dependency === undefined || !dependency.runnable || selected.has(id)) continue
      selected.set(id, dependency)
      pending.push(dependency)
    }
  }
  return [...selected.values()]
}

function topologicalOrder(tasks: readonly ProjectTask[], diagnostics: DiscoveryDiagnostic[]): ProjectTask[] {
  const byId = new Map(tasks.map(task => [task.id, task] as const))
  const indegree = new Map<string, number>(tasks.map(task => [task.id, 0]))
  const dependents = new Map<string, string[]>()
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) continue
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1)
      const rows = dependents.get(dependency) ?? []
      rows.push(task.id)
      dependents.set(dependency, rows)
    }
  }
  const ready = tasks.filter(task => indegree.get(task.id) === 0).sort(taskOrder)
  const ordered: ProjectTask[] = []
  while (ready.length > 0) {
    const task = ready.shift()!
    ordered.push(task)
    for (const id of dependents.get(task.id) ?? []) {
      const next = (indegree.get(id) ?? 1) - 1
      indegree.set(id, next)
      if (next === 0) {
        ready.push(byId.get(id)!)
        ready.sort(taskOrder)
      }
    }
  }
  if (ordered.length !== tasks.length) {
    diagnostics.push({
      source: 'all',
      code: 'task-dependency-cycle',
      message: 'Affected tasks contain a dependency cycle; cyclic tasks use stable order.',
    })
    const included = new Set(ordered.map(task => task.id))
    ordered.push(...tasks.filter(task => !included.has(task.id)).sort(taskOrder))
  }
  return ordered
}

/** Build a stable, bounded execution plan from explicit workspace-relative changes. */
export function createTaskPlan(
  tasks: readonly ProjectTask[],
  changedFileInput: readonly string[],
  goal: PlanGoal,
): TaskPlan {
  if (!(goal in GOAL_PURPOSES)) throw new Error('goal must be verify, build, or all')
  const changedFiles = normalizeChangedFiles(changedFileInput)
  const workspaces = affectedWorkspaces(tasks, changedFiles)
  const workspaceSet = new Set(workspaces)
  const purposes = GOAL_PURPOSES[goal]
  const initial = tasks.filter(task => task.runnable && purposes.has(task.purpose)
    && (task.workspace === '.' || workspaceSet.has(task.workspace)))
  const diagnostics: DiscoveryDiagnostic[] = []
  const planned = topologicalOrder(dependencyClosure(initial, tasks), diagnostics)
  const changedFilesDigest = digest(changedFiles)
  const planProjection = {
    planVersion: 1,
    goal,
    changedFilesDigest,
    affectedWorkspaces: workspaces,
    tasks: planned.map(task => ({
      id: task.id,
      manifestDigest: task.manifestDigest,
      dependsOn: task.dependsOn.filter(id => planned.some(candidate => candidate.id === id)),
    })),
  }
  return {
    planVersion: 1,
    goal,
    changedFiles,
    changedFilesDigest,
    planDigest: digest(planProjection),
    affectedWorkspaces: workspaces,
    tasks: planned,
    diagnostics,
  }
}
