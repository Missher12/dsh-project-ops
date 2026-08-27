import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, test } from 'vitest'
import * as ProjectOps from '../src/index.ts'

const roots: string[] = []
const signal = new AbortController().signal
const platformExecutor = process.platform === 'win32' ? 'pwsh' : 'bash'

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-project-ops-'))
  roots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    packageManager: 'pnpm@11.7.0',
    scripts: { verify: 'node -e "process.exit(0)"' },
  }))
  return root
}

function agent(cwd: string, id = 'project-ops-agent'): Agent {
  return {
    id: id as SessionId,
    session: { id: id as SessionId, header: { cwd } },
  } as unknown as Agent
}

async function setup(cwd: string) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry, {})
  ctx.jobs.attachController('project-ops-test')
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd, diffBasisMaxBytes: 1024 * 1024 })
  const fiber = await ctx.plugin(ProjectOps)
  return { ctx, fiber }
}

function registerAgent(ctx: Context, owner: Agent): void {
  Object.defineProperty(owner, 'ctx', { configurable: true, value: ctx })
  ctx.agents.register(owner)
}

function call(ctx: Context, owner: Agent, name: string, arguments_: unknown, callId = 'outer') {
  return ctx.tools.execute({
    callId: CallId(callId),
    name,
    arguments: arguments_,
    agent: owner,
    signal,
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Project Ops Cordis plugin', () => {
  test('registers exactly six namespaced tools and removes them on disposal', async () => {
    const { ctx, fiber } = await setup(workspace())
    const names = ctx.tools.schemas().map(tool => tool.name).filter(name => name.startsWith('missher_project_ops_'))

    expect(names).toEqual([
      'missher_project_ops_task_list',
      'missher_project_ops_task_plan',
      'missher_project_ops_task_run',
      'missher_project_ops_task_collect',
      'missher_project_ops_verification_gate',
      'missher_project_ops_capability_search',
    ])
    await fiber.dispose()
    expect(ctx.tools.schemas().some(tool => tool.name.startsWith('missher_project_ops_'))).toBe(false)
  })

  test('derives the Session cwd and rejects a stale digest before shell dispatch', async () => {
    const cwd = workspace()
    const { ctx } = await setup(cwd)
    const owner = agent(cwd)
    let nestedCalls = 0
    ctx.tools.register(defineTool({
      name: platformExecutor,
      description: 'Test shell.',
      parameters: platformExecutor === 'bash'
        ? {
            command: { type: 'string', required: true },
            description: { type: 'string', required: true },
            workdir: { type: 'string' },
          }
        : { command: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: () => [{ type: 'text', text: 'ran' }],
      },
      async execute() {
        nestedCalls += 1
        return { kind: 'foreground', exitCode: 0 }
      },
    }))

    const listed = await call(ctx, owner, 'missher_project_ops_task_list', {})
    expect(listed.isError).toBe(false)
    const task = (listed as { value: { tasks: { id: string; manifestDigest: string }[] } }).value.tasks[0]!
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@11.7.0',
      scripts: { verify: 'changed' },
    }))

    const stale = await call(ctx, owner, 'missher_project_ops_task_run', {
      taskId: task.id,
      manifestDigest: task.manifestDigest,
    })
    expect(stale.isError).toBe(true)
    expect(stale.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('manifest changed') })
    expect(nestedCalls).toBe(0)
  })

  test('nested-dispatches through the visible shell with the outer identity and returns a receipt', async () => {
    const cwd = workspace()
    const { ctx } = await setup(cwd)
    const owner = agent(cwd)
    registerAgent(ctx, owner)
    let nested: ToolRunContext | undefined
    let nestedArgs: unknown
    ctx.tools.register(defineTool({
      name: platformExecutor,
      description: 'Test shell.',
      parameters: platformExecutor === 'bash'
        ? {
            command: { type: 'string', required: true },
            description: { type: 'string', required: true },
            workdir: { type: 'string' },
          }
        : { command: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: () => [{ type: 'text', text: 'task output' }],
      },
      async execute(args, exec) {
        nested = exec
        nestedArgs = args
        return { kind: 'foreground', exitCode: 0 }
      },
    }))
    const listed = await call(ctx, owner, 'missher_project_ops_task_list', {})
    const task = (listed as { value: { tasks: { id: string; manifestDigest: string }[] } }).value.tasks[0]!

    const ran = await call(ctx, owner, 'missher_project_ops_task_run', {
      taskId: task.id,
      manifestDigest: task.manifestDigest,
    }, 'outer-call')

    expect(ran.isError).toBe(false)
    expect(nested).toMatchObject({
      agent: owner,
      callId: 'outer-call:project-ops:1',
      rootCallId: 'outer-call',
      signal,
    })
    expect(nested?.parent).toBeDefined()
    expect(nestedArgs).toMatchObject(platformExecutor === 'bash'
      ? { workdir: realpathSync(cwd), description: 'Run declared project task' }
      : { command: expect.any(String) })
    expect(ran.content.at(-1)).toMatchObject({ type: 'text', text: expect.stringContaining('"outcome": "succeeded"') })
  })

  test('plans affected workspace checks through the model tool', async () => {
    const cwd = workspace()
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@11.7.0',
      workspaces: ['packages/*'],
      scripts: { test: 'node -e "process.exit(0)"' },
    }))
    mkdirSync(join(cwd, 'packages', 'app'), { recursive: true })
    writeFileSync(join(cwd, 'packages', 'app', 'package.json'), JSON.stringify({
      name: '@test/app',
      scripts: { test: 'node -e "process.exit(0)"', dev: 'node server.js' },
    }))
    const { ctx } = await setup(cwd)
    const owner = agent(cwd)

    const planned = await call(ctx, owner, 'missher_project_ops_task_plan', {
      changedFiles: ['packages/app/src/index.ts'],
      goal: 'verify',
    })

    expect(planned.isError).toBe(false)
    expect((planned as { value: { planDigest: string; tasks: { id: string }[] } }).value).toMatchObject({
      planDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      tasks: [
        { id: 'package@packages/app:test' },
        { id: 'package:test' },
      ],
    })
  })

  test('auto mode waits briefly for a background job and returns a terminal receipt', async () => {
    const cwd = workspace()
    const { ctx } = await setup(cwd)
    const owner = agent(cwd)
    registerAgent(ctx, owner)
    ctx.tools.register(defineTool({
      name: platformExecutor,
      description: 'Background-capable test shell.',
      parameters: {
        command: { type: 'string', required: true },
        description: { type: 'string', required: true },
        workdir: { type: 'string' },
        run_in_background: { type: 'boolean' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: () => [{ type: 'text', text: 'started' }],
      },
      async execute(args, exec) {
        if (args.run_in_background !== true) return { kind: 'foreground', exitCode: 0 }
        return {
          kind: 'background',
          jobId: ctx.jobs.start({
            kind: platformExecutor,
            label: args.command,
            ...(exec.agent === undefined ? {} : { owner: exec.agent }),
            run: () => ({
              cancel() {},
              done: Promise.resolve({ status: 'completed', detail: 'exit code: 0' }),
              readOutput: () => 'short task output',
            }),
          }),
        }
      },
    }))
    const listed = await call(ctx, owner, 'missher_project_ops_task_list', {})
    const task = (listed as { value: { tasks: { id: string; manifestDigest: string }[] } }).value.tasks[0]!

    const ran = await call(ctx, owner, 'missher_project_ops_task_run', {
      taskId: task.id,
      manifestDigest: task.manifestDigest,
      mode: 'auto',
      waitMs: 100,
    })

    expect(ran.isError).toBe(false)
    expect((ran as { value: { receipt: { executionMode: string; outcome: string; jobId: string } } }).value.receipt)
      .toMatchObject({ executionMode: 'background', outcome: 'succeeded', jobId: `${platformExecutor}-1` })
    expect(ran.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('short task output') })
  })

  test('returns a running auto receipt, then owner-fenced collection settles it', async () => {
    const cwd = workspace()
    const { ctx } = await setup(cwd)
    const owner = agent(cwd)
    const stranger = agent(cwd, 'project-ops-stranger')
    registerAgent(ctx, owner)
    registerAgent(ctx, stranger)
    let finish!: (value: { status: 'completed'; detail: string }) => void
    const done = new Promise<{ status: 'completed'; detail: string }>(resolve => { finish = resolve })
    let output = 'first output'
    ctx.tools.register(defineTool({
      name: platformExecutor,
      description: 'Background-capable test shell.',
      parameters: {
        command: { type: 'string', required: true },
        description: { type: 'string', required: true },
        workdir: { type: 'string' },
        run_in_background: { type: 'boolean' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'started' }] },
      async execute(args, exec) {
        return {
          kind: 'background',
          jobId: ctx.jobs.start({
            kind: platformExecutor,
            label: args.command,
            ...(exec.agent === undefined ? {} : { owner: exec.agent }),
            run: () => ({ cancel() {}, done, readOutput: () => {
              const value = output
              output = ''
              return value
            } }),
          }),
        }
      },
    }))
    const listed = await call(ctx, owner, 'missher_project_ops_task_list', {})
    const task = (listed as { value: { tasks: { id: string; manifestDigest: string }[] } }).value.tasks[0]!
    const ran = await call(ctx, owner, 'missher_project_ops_task_run', {
      taskId: task.id,
      manifestDigest: task.manifestDigest,
      mode: 'auto',
      waitMs: 1,
    })
    const running = (ran as { value: { receipt: {
      jobId: string; nestedCallId: string; startedAt: string; outcome: string
    } } }).value.receipt
    expect(running).toMatchObject({ outcome: 'running', jobId: `${platformExecutor}-1` })

    const foreign = await call(ctx, stranger, 'missher_project_ops_task_collect', {
      taskId: task.id,
      manifestDigest: task.manifestDigest,
      jobId: running.jobId,
      nestedCallId: running.nestedCallId,
      startedAt: running.startedAt,
      waitMs: 1,
    })
    expect(foreign.isError).toBe(true)

    output = 'final output'
    finish({ status: 'completed', detail: 'exit code: 0' })
    const collected = await call(ctx, owner, 'missher_project_ops_task_collect', {
      taskId: task.id,
      manifestDigest: task.manifestDigest,
      jobId: running.jobId,
      nestedCallId: running.nestedCallId,
      startedAt: running.startedAt,
      waitMs: 100,
    })
    expect(collected.isError).toBe(false)
    expect((collected as { value: { receipt: { outcome: string } } }).value.receipt.outcome).toBe('succeeded')
    expect(collected.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('final output') })
  })

  test('refuses explicit background mode before dispatch when shell background is unavailable', async () => {
    const cwd = workspace()
    const { ctx } = await setup(cwd)
    const owner = agent(cwd)
    let nestedCalls = 0
    ctx.tools.register(defineTool({
      name: platformExecutor,
      description: 'Foreground-only shell.',
      parameters: {
        command: { type: 'string', required: true },
        description: { type: 'string', required: true },
        workdir: { type: 'string' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'ran' }] },
      async execute() {
        nestedCalls += 1
        return { kind: 'foreground', exitCode: 0 }
      },
    }))
    const listed = await call(ctx, owner, 'missher_project_ops_task_list', {})
    const task = (listed as { value: { tasks: { id: string; manifestDigest: string }[] } }).value.tasks[0]!

    const result = await call(ctx, owner, 'missher_project_ops_task_run', {
      taskId: task.id,
      manifestDigest: task.manifestDigest,
      mode: 'background',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('background execution is unavailable') })
    expect(nestedCalls).toBe(0)
  })

  test('recomputes the plan and passes only fresh execution receipts through the gate tool', async () => {
    const cwd = workspace()
    const { ctx } = await setup(cwd)
    const owner = agent(cwd)
    ctx.tools.register(defineTool({
      name: platformExecutor,
      description: 'Foreground verification shell.',
      parameters: {
        command: { type: 'string', required: true },
        description: { type: 'string', required: true },
        workdir: { type: 'string' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'verified' }] },
      async execute() { return { kind: 'foreground', exitCode: 0 } },
    }))
    const planned = await call(ctx, owner, 'missher_project_ops_task_plan', {
      changedFiles: ['src/index.ts'],
      goal: 'verify',
    })
    const plan = (planned as { value: { planDigest: string; tasks: { id: string; manifestDigest: string }[] } }).value
    const task = plan.tasks[0]!
    const ran = await call(ctx, owner, 'missher_project_ops_task_run', {
      taskId: task.id,
      manifestDigest: task.manifestDigest,
      mode: 'foreground',
    })
    const receipt = (ran as { value: { receipt: unknown } }).value.receipt

    const gated = await call(ctx, owner, 'missher_project_ops_verification_gate', {
      changedFiles: ['src/index.ts'],
      goal: 'verify',
      planDigest: plan.planDigest,
      receipts: [receipt],
    })

    expect(gated.isError).toBe(false)
    expect((gated as { value: { verdict: string } }).value.verdict).toBe('passed')
  })

  test('searches only tools visible to the calling Agent scope', async () => {
    const cwd = workspace()
    const { ctx } = await setup(cwd)
    ctx.tools.register(defineTool({
      name: 'secret_probe',
      description: 'Secret capability probe.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return 'secret' },
    }))
    const owner = agent(cwd, 'scoped-project-ops-agent')
    let scope!: Scope
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, owner) }, {
      inject: ['systemPrompt', 'tools'],
    }))
    scope.ctx.tools.restrict({ deny: ['secret_probe'] })

    const searched = await call(ctx, owner, 'missher_project_ops_capability_search', { query: 'secret', limit: 10 })

    expect(searched.isError).toBe(false)
    expect((searched as { value: { matches: { id: string }[] } }).value.matches).toEqual([])
  })
})
