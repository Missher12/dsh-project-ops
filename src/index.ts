import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { JobId, type JobSnapshot } from '@deepseek-ai/dsh-jobs'
import { CallId, type ContentBlock, type ToolSchema } from '@deepseek-ai/dsh-llm'
import { defineTool, type JsonValue, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { rankCapabilities, type CapabilityCandidate } from './capability-ranking.ts'
import type { ProjectTask } from './contracts.ts'
import { discoverProjectTasks, MAX_MANIFEST_BYTES, type ManifestReader } from './task-discovery.ts'
import {
  commandFor,
  createJobReceipt,
  createReceipt,
  receiptContent,
  type ExecutionReceipt,
  type ExecutorTool,
  type ReceiptResult,
} from './task-execution.ts'
import { createTaskPlan, type PlanGoal } from './task-planning.ts'
import { evaluateVerificationGate } from './verification-gate.ts'

/** Stable Cordis plugin name. */
export const name = 'missher-project-ops'

/** Harness services required by Project Ops. */
export const inject = ['fs', 'tools', 'jobs']

const TASK_LIST = 'missher_project_ops_task_list'
const TASK_PLAN = 'missher_project_ops_task_plan'
const TASK_RUN = 'missher_project_ops_task_run'
const TASK_COLLECT = 'missher_project_ops_task_collect'
const VERIFICATION_GATE = 'missher_project_ops_verification_gate'
const CAPABILITY_SEARCH = 'missher_project_ops_capability_search'
const LOCKFILES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
] as const

interface PublicTask {
  id: string
  name: string
  description: string
  source: ProjectTask['source']
  manifest: string
  manifestDigest: string
  workspace: string
  packageName?: string
  purpose: ProjectTask['purpose']
  dependsOn: string[]
  runnable: boolean
}

interface TaskRunValue {
  nestedContent: JsonValue[]
  receipt: ExecutionReceipt
}

class HarnessManifestReader implements ManifestReader {
  constructor(
    private readonly fs: FileSystem,
    private readonly cwd: string,
  ) {}

  async readCandidate(name: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    const pathInfo = await this.fs.lstat(name, { cwd: this.cwd }, signal)
    if (pathInfo === undefined || pathInfo.type !== 'file') return undefined
    if (pathInfo.size !== undefined && pathInfo.size > MAX_MANIFEST_BYTES) {
      return new Uint8Array(MAX_MANIFEST_BYTES + 1)
    }
    const target = await this.fs.resolve(name, {
      cwd: this.cwd,
      ...signal === undefined ? {} : { signal },
    })
    const root = await this.fs.resolve('.', { cwd: this.cwd, ...signal === undefined ? {} : { signal } })
    if (!this.fs.contains(root, target)) return undefined
    return this.fs.readBytes(target, signal, MAX_MANIFEST_BYTES)
  }

  async lockfiles(signal?: AbortSignal): Promise<readonly string[]> {
    const found: string[] = []
    for (const name of LOCKFILES) {
      const info = await this.fs.lstat(name, { cwd: this.cwd }, signal)
      if (info?.type === 'file') found.push(name)
    }
    return found
  }

  async listDirectories(path: string, signal?: AbortSignal): Promise<readonly string[]> {
    const pathInfo = await this.fs.lstat(path, { cwd: this.cwd }, signal)
    if (pathInfo?.type !== 'directory') return []
    const root = await this.fs.resolve('.', { cwd: this.cwd, ...signal === undefined ? {} : { signal } })
    const directory = await this.fs.resolve(path, { cwd: this.cwd, ...signal === undefined ? {} : { signal } })
    if (!this.fs.contains(root, directory)) return []
    const entries = await this.fs.listDir(directory, signal)
    const names: string[] = []
    for (const entry of entries) {
      if (entry.type !== 'directory' || !this.fs.contains(root, entry.target)) continue
      const candidate = path === '.' ? entry.name : `${path}/${entry.name}`
      const info = await this.fs.lstat(candidate, { cwd: this.cwd }, signal)
      if (info?.type === 'directory') names.push(entry.name)
    }
    return names
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function sessionCwd(exec: ToolRunContext): string {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined || cwd.trim() === '') throw new Error('Project Ops requires an owning Agent Session cwd')
  return cwd
}

function reader(ctx: Context, exec: ToolRunContext): HarnessManifestReader {
  return new HarnessManifestReader(ctx.fs, sessionCwd(exec))
}

async function taskWorkdir(ctx: Context, cwd: string, task: ProjectTask, signal?: AbortSignal): Promise<string> {
  const root = await ctx.fs.resolve('.', { cwd, ...signal === undefined ? {} : { signal } })
  const directory = await ctx.fs.resolve(task.workspace, { cwd, ...signal === undefined ? {} : { signal } })
  if (!ctx.fs.contains(root, directory)) throw new Error('project task workspace escaped the Session cwd')
  return ctx.fs.processPath(directory)
}

function publicTask(task: ProjectTask): PublicTask {
  const {
    id,
    name: taskName,
    description,
    source,
    manifest,
    manifestDigest,
    workspace,
    packageName,
    purpose,
    dependsOn,
    runnable,
  } = task
  return {
    id,
    name: taskName,
    description,
    source,
    manifest,
    manifestDigest,
    workspace,
    ...packageName === undefined ? {} : { packageName },
    purpose,
    dependsOn,
    runnable,
  }
}

const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    description: { type: 'string', required: true },
    source: { type: 'string', enum: ['package', 'make', 'just'], required: true },
    manifest: { type: 'string', required: true },
    manifestDigest: { type: 'string', required: true },
    workspace: { type: 'string', required: true },
    packageName: { type: 'string' },
    purpose: { type: 'string', enum: ['test', 'lint', 'typecheck', 'build', 'format', 'other'], required: true },
    dependsOn: { type: 'array', items: { type: 'string' }, required: true },
    runnable: { type: 'boolean', required: true },
  },
} as const

const DIAGNOSTIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source: { type: 'string', enum: ['package', 'make', 'just', 'all'], required: true },
    code: { type: 'string', required: true },
    message: { type: 'string', required: true },
  },
} as const

const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    receiptVersion: { type: 'integer', const: 2, required: true },
    taskId: { type: 'string', required: true },
    source: { type: 'string', enum: ['package', 'make', 'just'], required: true },
    workspace: { type: 'string', required: true },
    purpose: { type: 'string', enum: ['test', 'lint', 'typecheck', 'build', 'format', 'other'], required: true },
    manifestDigest: { type: 'string', required: true },
    executionMode: { type: 'string', enum: ['foreground', 'background'], required: true },
    executorTool: { type: 'string', enum: ['bash', 'pwsh'] },
    nestedCallId: { type: 'string', required: true },
    jobId: { type: 'string' },
    startedAt: { type: 'string', required: true },
    durationMs: { type: 'integer', required: true },
    outcome: { type: 'string', enum: ['running', 'succeeded', 'failed', 'blocked', 'aborted', 'unavailable'], required: true },
    exitCode: { type: 'integer' },
  },
} as const

const GATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    gateVersion: { type: 'integer', const: 1, required: true },
    verdict: { type: 'string', enum: ['passed', 'pending', 'failed', 'stale'], required: true },
    planDigest: { type: 'string', required: true },
    requiredTaskIds: { type: 'array', items: { type: 'string' }, required: true },
    missingTaskIds: { type: 'array', items: { type: 'string' }, required: true },
    runningTaskIds: { type: 'array', items: { type: 'string' }, required: true },
    failedTaskIds: { type: 'array', items: { type: 'string' }, required: true },
    staleTaskIds: { type: 'array', items: { type: 'string' }, required: true },
    reasonCodes: { type: 'array', items: { type: 'string' }, required: true },
  },
} as const

function renderJson(value: JsonValue): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function taskListTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: TASK_LIST,
    description: 'List bounded root and declared-workspace tasks in the current Agent Session project.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tasks: { type: 'array', items: TASK_SCHEMA, required: true },
          diagnostics: { type: 'array', items: DIAGNOSTIC_SCHEMA, required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(_args, exec) {
      const discovered = await discoverProjectTasks(reader(ctx, exec), exec.signal)
      return { tasks: discovered.tasks.map(publicTask), diagnostics: discovered.diagnostics }
    },
  })
}

function taskPlanTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: TASK_PLAN,
    description: 'Plan safe affected verification/build tasks from explicit workspace-relative changed files.',
    parameters: {
      changedFiles: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'One through 256 workspace-relative changed file paths.',
      },
      goal: { type: 'string', enum: ['verify', 'build', 'all'], required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          planVersion: { type: 'integer', const: 1, required: true },
          goal: { type: 'string', enum: ['verify', 'build', 'all'], required: true },
          changedFilesDigest: { type: 'string', required: true },
          planDigest: { type: 'string', required: true },
          affectedWorkspaces: { type: 'array', items: { type: 'string' }, required: true },
          tasks: { type: 'array', items: TASK_SCHEMA, required: true },
          diagnostics: { type: 'array', items: DIAGNOSTIC_SCHEMA, required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const discovered = await discoverProjectTasks(reader(ctx, exec), exec.signal)
      const plan = createTaskPlan(discovered.tasks, args.changedFiles, args.goal as PlanGoal)
      return {
        planVersion: plan.planVersion,
        goal: plan.goal,
        changedFilesDigest: plan.changedFilesDigest,
        planDigest: plan.planDigest,
        affectedWorkspaces: plan.affectedWorkspaces,
        tasks: plan.tasks.map(publicTask),
        diagnostics: [...discovered.diagnostics, ...plan.diagnostics],
      }
    },
  })
}

function executorFor(ctx: Context, owner: Agent | undefined): ExecutorTool | undefined {
  const selected: ExecutorTool = process.platform === 'win32' ? 'pwsh' : 'bash'
  return ctx.tools.get(selected, owner) === undefined ? undefined : selected
}

function schemaFor(ctx: Context, owner: Agent | undefined, name: string): ToolSchema | undefined {
  return ctx.tools.schemas(owner).find(schema => schema.name === name)
}

function parameterProperties(schema: ToolSchema | undefined): Record<string, unknown> {
  return record(schema?.parameters.properties) ?? {}
}

function supportsBackground(ctx: Context, owner: Agent | undefined, executor: ExecutorTool): boolean {
  return Object.hasOwn(parameterProperties(schemaFor(ctx, owner, executor)), 'run_in_background')
}

function shellArguments(
  ctx: Context,
  owner: Agent | undefined,
  executor: ExecutorTool,
  command: string,
  workdir: string,
  background: boolean,
): Record<string, JsonValue> {
  const properties = parameterProperties(schemaFor(ctx, owner, executor))
  return {
    command,
    ...Object.hasOwn(properties, 'description') ? { description: 'Run declared project task' } : {},
    ...Object.hasOwn(properties, 'workdir') ? { workdir } : {},
    ...background ? { run_in_background: true } : {},
  }
}

function backgroundJobId(result: ReceiptResult): string | undefined {
  if (result.isError) return undefined
  const value = record(result.value)
  return value?.kind === 'background' && typeof value.jobId === 'string' ? value.jobId : undefined
}

function jobContent(output: string, fallback: readonly ContentBlock[]): ContentBlock[] {
  return output === '' ? [...fallback] : [{ type: 'text', text: output }]
}

async function rediscoveredTask(
  ctx: Context,
  exec: ToolRunContext,
  taskId: string,
  manifestDigest: string,
): Promise<ProjectTask> {
  if (taskId.trim() === '' || taskId.length > 256) throw new Error('taskId must contain 1 through 256 characters')
  if (!/^[a-f0-9]{64}$/u.test(manifestDigest)) throw new Error('manifestDigest must be a lowercase SHA-256 digest')
  const discovered = await discoverProjectTasks(reader(ctx, exec), exec.signal)
  const task = discovered.tasks.find(candidate => candidate.id === taskId)
  if (task === undefined) throw new Error(`project task ${JSON.stringify(taskId)} is not declared`)
  if (task.manifestDigest !== manifestDigest) throw new Error(`project task ${JSON.stringify(taskId)} manifest changed; list tasks again`)
  if (!task.runnable || task.invocation === undefined) throw new Error(`project task ${JSON.stringify(taskId)} is not runnable`)
  return task
}

function taskRunTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: TASK_RUN,
    description: 'Run one fresh declared task in foreground, background, or background-first auto mode.',
    parameters: {
      taskId: { type: 'string', required: true, description: `Task id returned by ${TASK_LIST} or ${TASK_PLAN}.` },
      manifestDigest: { type: 'string', required: true, description: 'Matching lowercase SHA-256 manifest digest.' },
      mode: {
        type: 'string',
        enum: ['foreground', 'background', 'auto'],
        description: 'Defaults to foreground for backward compatibility.',
      },
      waitMs: { type: 'integer', description: 'Auto-mode wait from 1 through 10000 ms; defaults to 3000.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          nestedContent: { type: 'array', items: { type: 'json' }, required: true },
          receipt: { ...RECEIPT_SCHEMA, required: true },
        },
      },
      render: (_args, value) => {
        const output = value as unknown as TaskRunValue
        return receiptContent(output.nestedContent as unknown as ContentBlock[], output.receipt)
      },
    },
    async execute(args, exec) {
      const mode = args.mode ?? 'foreground'
      const waitMs = args.waitMs ?? 3_000
      if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > 10_000) throw new Error('waitMs must be an integer from 1 through 10000')
      const cwd = sessionCwd(exec)
      const task = await rediscoveredTask(ctx, exec, args.taskId, args.manifestDigest)
      const executorTool = executorFor(ctx, exec.agent)
      const nestedCallId = CallId(`${exec.callId}:project-ops:1`)
      const startedAtMs = Date.now()
      const startedAt = new Date(startedAtMs).toISOString()
      if (executorTool === undefined) {
        const receipt = createReceipt({ task, nestedCallId, startedAt, durationMs: Date.now() - startedAtMs })
        return {
          nestedContent: [{ type: 'text', text: 'No platform shell tool is visible to this Agent.' }] as unknown as JsonValue[],
          receipt,
        }
      }

      const backgroundAvailable = supportsBackground(ctx, exec.agent, executorTool)
      if (mode === 'background' && !backgroundAvailable) throw new Error('background execution is unavailable for the visible shell tool')
      const background = mode !== 'foreground' && backgroundAvailable
      const command = commandFor(task, executorTool)
      const workdir = await taskWorkdir(ctx, cwd, task, exec.signal)
      const result = await ctx.tools.execute({
        callId: nestedCallId,
        rootCallId: exec.rootCallId,
        name: executorTool,
        arguments: shellArguments(ctx, exec.agent, executorTool, command, workdir, background),
        ...exec.agent === undefined ? {} : { agent: exec.agent },
        parent: exec.token,
        signal: exec.signal,
      }) as ReceiptResult

      if (!background) {
        const receipt = createReceipt({
          task,
          executorTool,
          nestedCallId,
          startedAt,
          durationMs: Date.now() - startedAtMs,
          result,
        })
        return { nestedContent: [...result.content] as unknown as JsonValue[], receipt }
      }

      const jobId = backgroundJobId(result)
      if (jobId === undefined) {
        const receipt = createReceipt({
          task,
          executorTool,
          nestedCallId,
          startedAt,
          durationMs: Date.now() - startedAtMs,
          executionMode: 'background',
          result,
        })
        return { nestedContent: [...result.content] as unknown as JsonValue[], receipt }
      }
      let snapshot: JobSnapshot
      let output = ''
      if (mode === 'auto') {
        snapshot = await ctx.jobs.wait(JobId(jobId), waitMs, exec.agent, exec.signal)
        const read = ctx.jobs.read(JobId(jobId), exec.agent)
        snapshot = read.snapshot
        output = read.text
      } else {
        snapshot = ctx.jobs.get(JobId(jobId), exec.agent)
      }
      const receipt = createJobReceipt({
        task,
        executorTool,
        nestedCallId,
        jobId,
        startedAt,
        durationMs: Date.now() - startedAtMs,
        snapshot,
        output,
      })
      return {
        nestedContent: jobContent(output, result.content) as unknown as JsonValue[],
        receipt,
      }
    },
  })
}

function taskCollectTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: TASK_COLLECT,
    description: 'Poll or wait for one Project Ops background task and return a fresh owner-fenced receipt.',
    parameters: {
      taskId: { type: 'string', required: true },
      manifestDigest: { type: 'string', required: true },
      jobId: { type: 'string', required: true },
      nestedCallId: { type: 'string', required: true },
      startedAt: { type: 'string', required: true },
      waitMs: { type: 'integer', description: 'Optional wait from 1 through 10000 ms; omission polls immediately.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          nestedContent: { type: 'array', items: { type: 'json' }, required: true },
          receipt: { ...RECEIPT_SCHEMA, required: true },
        },
      },
      render: (_args, value) => {
        const output = value as unknown as TaskRunValue
        return receiptContent(output.nestedContent as unknown as ContentBlock[], output.receipt)
      },
    },
    async execute(args, exec) {
      if (args.jobId.trim() === '' || args.jobId.length > 128) throw new Error('jobId must contain 1 through 128 characters')
      if (args.nestedCallId.trim() === '' || args.nestedCallId.length > 512) throw new Error('nestedCallId must contain 1 through 512 characters')
      const startedAtMs = Date.parse(args.startedAt)
      if (!Number.isFinite(startedAtMs)) throw new Error('startedAt must be an ISO timestamp')
      if (args.waitMs !== undefined && (!Number.isInteger(args.waitMs) || args.waitMs < 1 || args.waitMs > 10_000)) {
        throw new Error('waitMs must be an integer from 1 through 10000')
      }
      const task = await rediscoveredTask(ctx, exec, args.taskId, args.manifestDigest)
      const executorTool = executorFor(ctx, exec.agent)
      if (executorTool === undefined) throw new Error('No platform shell tool is visible to this Agent.')
      const id = JobId(args.jobId)
      if (args.waitMs !== undefined) await ctx.jobs.wait(id, args.waitMs, exec.agent, exec.signal)
      const snapshot = ctx.jobs.get(id, exec.agent)
      if (snapshot.kind !== executorTool || snapshot.label !== commandFor(task, executorTool)) {
        throw new Error('background job does not belong to the declared project task')
      }
      const read = ctx.jobs.read(id, exec.agent)
      const receipt = createJobReceipt({
        task,
        executorTool,
        nestedCallId: args.nestedCallId,
        jobId: args.jobId,
        startedAt: args.startedAt,
        durationMs: Date.now() - startedAtMs,
        snapshot: read.snapshot,
        output: read.text,
      })
      return {
        nestedContent: [{ type: 'text', text: read.text === '' ? '(no new job output)' : read.text }] as unknown as JsonValue[],
        receipt,
      }
    },
  })
}

function verificationGateTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: VERIFICATION_GATE,
    description: 'Recompute an affected-task plan and decide whether supplied Project Ops receipts are fresh and complete.',
    parameters: {
      changedFiles: { type: 'array', items: { type: 'string' }, required: true },
      goal: { type: 'string', enum: ['verify', 'build', 'all'], required: true },
      planDigest: { type: 'string', required: true },
      receipts: { type: 'array', items: RECEIPT_SCHEMA, required: true },
    },
    output: { schema: GATE_SCHEMA, render: (_args, value) => renderJson(value) },
    async execute(args, exec) {
      const discovered = await discoverProjectTasks(reader(ctx, exec), exec.signal)
      const plan = createTaskPlan(discovered.tasks, args.changedFiles, args.goal as PlanGoal)
      return evaluateVerificationGate(plan, discovered.tasks, args.receipts as ExecutionReceipt[], args.planDigest)
    },
  })
}

function capabilitySearchTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: CAPABILITY_SEARCH,
    description: 'Search tools visible to this Agent and tasks declared by its current project workspaces.',
    parameters: {
      query: { type: 'string', required: true, description: 'Capability or task to find.' },
      limit: { type: 'integer', description: 'Maximum matches from 1 through 10; defaults to 5.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                source: { type: 'string', enum: ['project-task', 'tool'], required: true },
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                score: { type: 'integer', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const discovered = await discoverProjectTasks(reader(ctx, exec), exec.signal)
      const candidates: CapabilityCandidate[] = [
        ...ctx.tools.schemas(exec.agent).map(tool => ({
          source: 'tool' as const,
          id: `tool:${tool.name}`,
          name: tool.name,
          description: tool.description,
        })),
        ...discovered.tasks.map(task => ({
          source: 'project-task' as const,
          id: task.id,
          name: task.name,
          description: task.description,
        })),
      ]
      return { matches: rankCapabilities(args.query, candidates, args.limit ?? 5) }
    },
  })
}

/** Register the Project Ops model tools. */
export function apply(ctx: Context): void {
  ctx.tools.register(taskListTool(ctx))
  ctx.tools.register(taskPlanTool(ctx))
  ctx.tools.register(taskRunTool(ctx))
  ctx.tools.register(taskCollectTool(ctx))
  ctx.tools.register(verificationGateTool(ctx))
  ctx.tools.register(capabilitySearchTool(ctx))
}
