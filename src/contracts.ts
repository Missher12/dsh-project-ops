/** Task declaration families supported by Project Ops. */
export type TaskSource = 'package' | 'make' | 'just'

/** Stable purpose inferred only from a declared task name. */
export type TaskPurpose = 'test' | 'lint' | 'typecheck' | 'build' | 'format' | 'other'

/** Fixed execution data derived from one task manifest. */
export type TaskInvocation =
  | { kind: 'package'; manager: 'npm' | 'pnpm' | 'yarn' | 'bun'; script: string; cwd: string }
  | { kind: 'make'; target: string }
  | { kind: 'just'; recipe: string }

/** One task declaration returned to the model. */
export interface ProjectTask {
  id: string
  name: string
  description: string
  source: TaskSource
  manifest: string
  manifestDigest: string
  workspace: string
  packageName?: string
  purpose: TaskPurpose
  dependsOn: string[]
  runnable: boolean
  invocation?: TaskInvocation
}

/** Bounded task-source diagnostic that never includes manifest contents. */
export interface DiscoveryDiagnostic {
  source: TaskSource | 'all'
  code: string
  message: string
}

/** Complete bounded task discovery result. */
export interface TaskDiscoveryResult {
  tasks: ProjectTask[]
  diagnostics: DiscoveryDiagnostic[]
}
