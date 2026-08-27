import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ProjectTask } from './contracts.ts'

export type ExecutorTool = 'bash' | 'pwsh'
export type ExecutionMode = 'foreground' | 'background'
export type ExecutionOutcome = 'running' | 'succeeded' | 'failed' | 'blocked' | 'aborted' | 'unavailable'

/** Nested tool result fields required to derive one receipt. */
export type ReceiptResult =
  | { isError: false; content: readonly ContentBlock[]; value: unknown }
  | { isError: true; content: readonly ContentBlock[]; error: { message: string; info?: { name: string; code: string } } }

/** Durable, output-free summary of one Project Ops task dispatch. */
export interface ExecutionReceipt {
  receiptVersion: 2
  taskId: string
  source: ProjectTask['source']
  workspace: string
  purpose: ProjectTask['purpose']
  manifestDigest: string
  executionMode: ExecutionMode
  executorTool?: ExecutorTool
  nestedCallId: string
  jobId?: string
  startedAt: string
  durationMs: number
  outcome: ExecutionOutcome
  exitCode?: number
}

export interface ReceiptInput {
  task: ProjectTask
  executorTool?: ExecutorTool
  nestedCallId: string
  startedAt: string
  durationMs: number
  executionMode?: ExecutionMode
  result?: ReceiptResult
}

export interface JobReceiptInput {
  task: ProjectTask
  executorTool: ExecutorTool
  nestedCallId: string
  jobId: string
  startedAt: string
  durationMs: number
  snapshot: JobSnapshot
  output?: string
}

function quote(value: string, executor: ExecutorTool): string {
  return executor === 'bash'
    ? `'${value.replaceAll("'", "'\\''")}'`
    : `'${value.replaceAll("'", "''")}'`
}

/** Construct one fixed invocation from a rediscovered task declaration. */
export function commandFor(task: ProjectTask, executor: ExecutorTool): string {
  const invocation = task.invocation
  if (!task.runnable || invocation === undefined) throw new Error('task is not runnable')
  switch (invocation.kind) {
    case 'package':
      return `${invocation.manager} run ${quote(invocation.script, executor)}`
    case 'make':
      return `make -- ${quote(invocation.target, executor)}`
    case 'just':
      return `just -- ${quote(invocation.recipe, executor)}`
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function foregroundExitCode(result: ReceiptResult | undefined): number | undefined {
  if (result === undefined || result.isError) return undefined
  const value = record(result.value)
  if (typeof value?.exitCode === 'number' && Number.isInteger(value.exitCode)) return value.exitCode
  if (typeof result.value === 'string') {
    const match = /\[exit code: (-?\d+)\]/u.exec(result.value)
    if (match !== null) return Number(match[1])
  }
  return undefined
}

function foregroundOutcome(input: ReceiptInput): ExecutionOutcome {
  const result = input.result
  if (input.executorTool === undefined || result === undefined) return 'unavailable'
  if (result.isError) {
    const code = result.error.info?.code ?? ''
    if (code === 'ABORTED' || code === 'ABORTED_BEFORE_DISPATCH') return 'aborted'
    if (/APPROVAL|BLOCK|DENIED|PERMISSION|SANDBOX/u.test(code)) return 'blocked'
    return 'failed'
  }
  const value = record(result.value)
  if (value?.aborted === true) return 'aborted'
  if (record(value?.sandbox)?.denied === true) return 'blocked'
  const code = foregroundExitCode(result)
  return code !== undefined && code !== 0 ? 'failed' : 'succeeded'
}

function jobExitCode(snapshot: JobSnapshot): number | undefined {
  const match = /(?:^|\b)exit code:\s*(-?\d+)(?:\b|$)/u.exec(snapshot.detail ?? '')
  return match === null ? undefined : Number(match[1])
}

function jobOutcome(snapshot: JobSnapshot, output: string | undefined): ExecutionOutcome {
  if (snapshot.status === 'running' || snapshot.status === 'stopping') return 'running'
  if (snapshot.status === 'killed') return 'aborted'
  if (snapshot.status === 'failed') return 'failed'
  if (/\[sandbox: file access denied under [^\]]+\]/u.test(output ?? '')) return 'blocked'
  const code = jobExitCode(snapshot)
  return code !== undefined && code !== 0 ? 'failed' : 'succeeded'
}

function receiptBase(task: ProjectTask, startedAt: string, durationMs: number) {
  return {
    receiptVersion: 2 as const,
    taskId: task.id,
    source: task.source,
    workspace: task.workspace,
    purpose: task.purpose,
    manifestDigest: task.manifestDigest,
    startedAt,
    durationMs: Math.max(0, Math.round(durationMs)),
  }
}

/** Project a nested foreground tool settlement into a durable output-free receipt. */
export function createReceipt(input: ReceiptInput): ExecutionReceipt {
  const code = foregroundExitCode(input.result)
  return {
    ...receiptBase(input.task, input.startedAt, input.durationMs),
    executionMode: input.executionMode ?? 'foreground',
    ...input.executorTool === undefined ? {} : { executorTool: input.executorTool },
    nestedCallId: input.nestedCallId,
    outcome: foregroundOutcome(input),
    ...code === undefined ? {} : { exitCode: code },
  }
}

/** Project an owner-fenced Harness Job snapshot into a durable output-free receipt. */
export function createJobReceipt(input: JobReceiptInput): ExecutionReceipt {
  const code = jobExitCode(input.snapshot)
  return {
    ...receiptBase(input.task, input.startedAt, input.durationMs),
    executionMode: 'background',
    executorTool: input.executorTool,
    nestedCallId: input.nestedCallId,
    jobId: input.jobId,
    outcome: jobOutcome(input.snapshot, input.output),
    ...code === undefined ? {} : { exitCode: code },
  }
}

/** Forward nested content and append one receipt block. */
export function receiptContent(nested: readonly ContentBlock[], receipt: ExecutionReceipt): ContentBlock[] {
  return [
    ...nested,
    {
      type: 'text',
      text: `Project Ops receipt:\n\`\`\`json\n${JSON.stringify(receipt, null, 2)}\n\`\`\``,
    },
  ]
}
