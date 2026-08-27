import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ProjectTask } from './contracts.ts'

export type ExecutorTool = 'bash' | 'pwsh'
export type ExecutionOutcome = 'succeeded' | 'failed' | 'blocked' | 'aborted' | 'unavailable'

/** Nested tool result fields required to derive one receipt. */
export type ReceiptResult =
  | { isError: false; content: readonly ContentBlock[]; value: unknown }
  | { isError: true; content: readonly ContentBlock[]; error: { message: string; info?: { name: string; code: string } } }

/** Durable, output-free summary of one Project Ops task dispatch. */
export interface ExecutionReceipt {
  receiptVersion: 1
  taskId: string
  source: ProjectTask['source']
  manifestDigest: string
  executorTool?: ExecutorTool
  nestedCallId: string
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
  result?: ReceiptResult
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

function exitCode(result: ReceiptResult | undefined): number | undefined {
  if (result === undefined || result.isError) return undefined
  const value = record(result.value)
  if (typeof value?.exitCode === 'number' && Number.isInteger(value.exitCode)) return value.exitCode
  if (typeof result.value === 'string') {
    const match = /\[exit code: (-?\d+)\]/.exec(result.value)
    if (match !== null) return Number(match[1])
  }
  return undefined
}

function outcome(input: ReceiptInput): ExecutionOutcome {
  const result = input.result
  if (input.executorTool === undefined || result === undefined) return 'unavailable'
  if (result.isError) {
    const code = result.error.info?.code ?? ''
    if (code === 'ABORTED' || code === 'ABORTED_BEFORE_DISPATCH') return 'aborted'
    if (/APPROVAL|BLOCK|DENIED|PERMISSION|SANDBOX/.test(code)) return 'blocked'
    return 'failed'
  }
  const value = record(result.value)
  if (value?.aborted === true) return 'aborted'
  if (record(value?.sandbox)?.denied === true) return 'blocked'
  const code = exitCode(result)
  return code !== undefined && code !== 0 ? 'failed' : 'succeeded'
}

/** Project a nested tool settlement into a durable output-free receipt. */
export function createReceipt(input: ReceiptInput): ExecutionReceipt {
  const code = exitCode(input.result)
  return {
    receiptVersion: 1,
    taskId: input.task.id,
    source: input.task.source,
    manifestDigest: input.task.manifestDigest,
    ...input.executorTool === undefined ? {} : { executorTool: input.executorTool },
    nestedCallId: input.nestedCallId,
    startedAt: input.startedAt,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    outcome: outcome(input),
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
