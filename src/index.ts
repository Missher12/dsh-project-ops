import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { CallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type JsonValue, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { rankCapabilities, type CapabilityCandidate } from './capability-ranking.ts'
import type { ProjectTask } from './contracts.ts'
import { discoverProjectTasks, MAX_MANIFEST_BYTES, type ManifestReader } from './task-discovery.ts'
import {
  commandFor,
  createReceipt,
  receiptContent,
  type ExecutionReceipt,
  type ExecutorTool,
  type ReceiptResult,
} from './task-execution.ts'

/** Stable Cordis plugin name. */
export const name = 'missher-project-ops'

/** Harness services required by Project Ops. */
export const inject = ['fs', 'tools']

const TASK_LIST = 'missher_project_ops_task_list'
const TASK_RUN = 'missher_project_ops_task_run'
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

function sessionCwd(exec: ToolRunContext): string {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined || cwd.trim() === '') throw new Error('Project Ops requires an owning Agent Session cwd')
  return cwd
}

function reader(ctx: Context, exec: ToolRunContext): HarnessManifestReader {
  return new HarnessManifestReader(ctx.fs, sessionCwd(exec))
}

function publicTask(task: ProjectTask): PublicTask {
  const { id, name, description, source, manifest, manifestDigest, runnable } = task
  return { id, name, description, source, manifest, manifestDigest, runnable }
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
    receiptVersion: { type: 'integer', const: 1, required: true },
    taskId: { type: 'string', required: true },
    source: { type: 'string', enum: ['package', 'make', 'just'], required: true },
    manifestDigest: { type: 'string', required: true },
    executorTool: { type: 'string', enum: ['bash', 'pwsh'] },
    nestedCallId: { type: 'string', required: true },
    startedAt: { type: 'string', required: true },
    durationMs: { type: 'integer', required: true },
    outcome: { type: 'string', enum: ['succeeded', 'failed', 'blocked', 'aborted', 'unavailable'], required: true },
    exitCode: { type: 'integer' },
  },
} as const

function renderJson(value: JsonValue): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function taskListTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: TASK_LIST,
    description: 'List runnable tasks declared by bounded manifests in the current Agent Session workspace.',
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

function executorFor(ctx: Context, owner: Agent | undefined): ExecutorTool | undefined {
  const selected: ExecutorTool = process.platform === 'win32' ? 'pwsh' : 'bash'
  return ctx.tools.get(selected, owner) === undefined ? undefined : selected
}

function taskRunTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: TASK_RUN,
    description: 'Run one rediscovered project task by id and digest; inspect the returned receipt outcome.',
    parameters: {
      taskId: { type: 'string', required: true, description: `Task id returned by ${TASK_LIST}.` },
      manifestDigest: { type: 'string', required: true, description: `Manifest digest returned by ${TASK_LIST}.` },
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
      if (args.taskId.trim() === '' || args.taskId.length > 256) throw new Error('taskId must contain 1 through 256 characters')
      if (!/^[a-f0-9]{64}$/.test(args.manifestDigest)) throw new Error('manifestDigest must be a lowercase SHA-256 digest')
      const cwd = sessionCwd(exec)
      const discovered = await discoverProjectTasks(reader(ctx, exec), exec.signal)
      const task = discovered.tasks.find(candidate => candidate.id === args.taskId)
      if (task === undefined) throw new Error(`project task ${JSON.stringify(args.taskId)} is not declared`)
      if (task.manifestDigest !== args.manifestDigest) throw new Error(`project task ${JSON.stringify(args.taskId)} manifest changed; list tasks again`)
      if (!task.runnable || task.invocation === undefined) throw new Error(`project task ${JSON.stringify(args.taskId)} is not runnable`)

      const executorTool = executorFor(ctx, exec.agent)
      const nestedCallId = CallId(`${exec.callId}:project-ops:1`)
      const startedAtMs = Date.now()
      const startedAt = new Date(startedAtMs).toISOString()
      if (executorTool === undefined) {
        const receipt = createReceipt({
          task,
          nestedCallId,
          startedAt,
          durationMs: Date.now() - startedAtMs,
        })
        return {
          nestedContent: [{ type: 'text', text: 'No platform shell tool is visible to this Agent.' }] as unknown as JsonValue[],
          receipt,
        }
      }

      const command = commandFor(task, executorTool)
      const result = await ctx.tools.execute({
        callId: nestedCallId,
        rootCallId: exec.rootCallId,
        name: executorTool,
        arguments: executorTool === 'bash'
          ? { command, description: 'Run declared project task', workdir: cwd }
          : { command },
        ...exec.agent === undefined ? {} : { agent: exec.agent },
        parent: exec.token,
        signal: exec.signal,
      })
      const receipt = createReceipt({
        task,
        executorTool,
        nestedCallId,
        startedAt,
        durationMs: Date.now() - startedAtMs,
        result: result as ReceiptResult,
      })
      return { nestedContent: [...result.content] as unknown as JsonValue[], receipt }
    },
  })
}

function capabilitySearchTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: CAPABILITY_SEARCH,
    description: 'Search tools visible to this Agent and tasks declared by its current project.',
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
  ctx.tools.register(taskRunTool(ctx))
  ctx.tools.register(capabilitySearchTool(ctx))
}
