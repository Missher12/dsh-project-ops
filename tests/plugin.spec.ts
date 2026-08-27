import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
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
    session: { header: { cwd } },
  } as unknown as Agent
}

async function setup(cwd: string) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd, diffBasisMaxBytes: 1024 * 1024 })
  const fiber = await ctx.plugin(ProjectOps)
  return { ctx, fiber }
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
  test('registers exactly three namespaced tools and removes them on disposal', async () => {
    const { ctx, fiber } = await setup(workspace())
    const names = ctx.tools.schemas().map(tool => tool.name).filter(name => name.startsWith('missher_project_ops_'))

    expect(names).toEqual([
      'missher_project_ops_task_list',
      'missher_project_ops_task_run',
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
      ? { workdir: cwd, description: 'Run declared project task' }
      : { command: expect.any(String) })
    expect(ran.content.at(-1)).toMatchObject({ type: 'text', text: expect.stringContaining('"outcome": "succeeded"') })
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
