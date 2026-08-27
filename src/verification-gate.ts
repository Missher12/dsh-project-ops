import type { ProjectTask } from './contracts.ts'
import type { ExecutionReceipt } from './task-execution.ts'
import type { TaskPlan } from './task-planning.ts'

export type VerificationVerdict = 'passed' | 'pending' | 'failed' | 'stale'

export interface VerificationGate {
  gateVersion: 1
  verdict: VerificationVerdict
  planDigest: string
  requiredTaskIds: string[]
  missingTaskIds: string[]
  runningTaskIds: string[]
  failedTaskIds: string[]
  staleTaskIds: string[]
  reasonCodes: string[]
}

const REASON_ORDER = [
  'plan-digest-mismatch',
  'task-set-changed',
  'manifest-changed',
  'receipt-task-mismatch',
  'missing-receipt',
  'running-receipt',
  'unsuccessful-receipt',
] as const

function latestReceipt(receipts: readonly ExecutionReceipt[]): ExecutionReceipt | undefined {
  return [...receipts].sort((left, right) => {
    const time = Date.parse(right.startedAt) - Date.parse(left.startedAt)
    if (time !== 0) return time
    return JSON.stringify(right).localeCompare(JSON.stringify(left), 'en')
  })[0]
}

function orderedReasons(reasons: ReadonlySet<string>): string[] {
  return REASON_ORDER.filter(reason => reasons.has(reason))
}

/** Evaluate only fresh, task-scoped receipts against a freshly recomputed plan. */
export function evaluateVerificationGate(
  plan: TaskPlan,
  tasks: readonly ProjectTask[],
  receipts: readonly ExecutionReceipt[],
  expectedPlanDigest = plan.planDigest,
): VerificationGate {
  if (!/^[a-f0-9]{64}$/u.test(expectedPlanDigest)) throw new Error('planDigest must be a lowercase SHA-256 digest')
  for (const receipt of receipts) {
    if (receipt.receiptVersion !== 2 || !Number.isFinite(Date.parse(receipt.startedAt))) {
      throw new Error('receipts must contain valid version-2 execution receipts')
    }
  }

  const reasons = new Set<string>()
  const requiredTaskIds = plan.tasks.map(task => task.id)
  const currentById = new Map(tasks.map(task => [task.id, task] as const))
  const receiptByTask = new Map<string, ExecutionReceipt>()
  for (const taskId of requiredTaskIds) {
    const selected = latestReceipt(receipts.filter(receipt => receipt.taskId === taskId))
    if (selected !== undefined) receiptByTask.set(taskId, selected)
  }

  const missingTaskIds: string[] = []
  const runningTaskIds: string[] = []
  const failedTaskIds: string[] = []
  const staleTaskIds: string[] = []

  if (expectedPlanDigest !== plan.planDigest) reasons.add('plan-digest-mismatch')
  for (const planned of plan.tasks) {
    const current = currentById.get(planned.id)
    if (current === undefined) {
      staleTaskIds.push(planned.id)
      reasons.add('task-set-changed')
      continue
    }
    if (current.manifestDigest !== planned.manifestDigest) {
      staleTaskIds.push(planned.id)
      reasons.add('manifest-changed')
      continue
    }
    const receipt = receiptByTask.get(planned.id)
    if (receipt === undefined) {
      missingTaskIds.push(planned.id)
      reasons.add('missing-receipt')
      continue
    }
    if (receipt.manifestDigest !== current.manifestDigest) {
      staleTaskIds.push(planned.id)
      reasons.add('manifest-changed')
      continue
    }
    if (receipt.source !== current.source || receipt.workspace !== current.workspace || receipt.purpose !== current.purpose) {
      staleTaskIds.push(planned.id)
      reasons.add('receipt-task-mismatch')
      continue
    }
    if (receipt.outcome === 'running') {
      runningTaskIds.push(planned.id)
      reasons.add('running-receipt')
    } else if (receipt.outcome !== 'succeeded') {
      failedTaskIds.push(planned.id)
      reasons.add('unsuccessful-receipt')
    }
  }

  const stale = expectedPlanDigest !== plan.planDigest || staleTaskIds.length > 0
  const verdict: VerificationVerdict = stale
    ? 'stale'
    : failedTaskIds.length > 0
      ? 'failed'
      : missingTaskIds.length > 0 || runningTaskIds.length > 0
        ? 'pending'
        : 'passed'
  return {
    gateVersion: 1,
    verdict,
    planDigest: plan.planDigest,
    requiredTaskIds,
    missingTaskIds,
    runningTaskIds,
    failedTaskIds,
    staleTaskIds,
    reasonCodes: orderedReasons(reasons),
  }
}
