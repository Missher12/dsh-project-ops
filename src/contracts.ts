/** Task declaration families supported by Project Ops. */
export type TaskSource = 'package' | 'make' | 'just'

/** Fixed execution data derived from one task manifest. */
export type TaskInvocation =
  | { kind: 'package'; manager: 'npm' | 'pnpm' | 'yarn' | 'bun'; script: string }
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
