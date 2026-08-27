import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const dshPackageRoot = dirname(require.resolve('@deepseek-ai/dsh/package.json'))
const dshCli = join(dshPackageRoot, 'lib', 'bin.js')
const expectedEntries = [
  'package/LICENSE',
  'package/README.i18n.yaml',
  'package/README.md',
  'package/README.zh.md',
  'package/cordis.patch.yml',
  'package/lib/index.d.ts',
  'package/lib/index.js',
  'package/package.json',
]
const expectedPatch = '- insert:\n    - id: missher-project-ops\n      name: dsh-project-ops\n'

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? pluginRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: options.shell ?? false,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})${output === '' ? '' : `:\n${output}`}`)
  }
  return result.stdout ?? ''
}

function directorySentinel(path) {
  if (!existsSync(path)) return 'absent'
  const stat = lstatSync(path)
  invariant(stat.isDirectory(), 'live DSH_HOME exists but is not a directory')
  const names = readdirSync(path).sort()
  return createHash('sha256').update(JSON.stringify(names)).digest('hex')
}

function readProfileManifest(home, profile) {
  return JSON.parse(readFileSync(join(home, 'profiles', profile, 'package.json'), 'utf8'))
}

async function exercisePackedPlugin(entry, workspace) {
  const projectOps = await import(pathToFileURL(entry).href)
  const definitions = new Map()
  const jobRecords = new Map()
  const signal = new AbortController().signal
  const shellName = process.platform === 'win32' ? 'pwsh' : 'bash'
  const shellSchema = {
    name: shellName,
    description: 'Smoke shell.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        description: { type: 'string' },
        workdir: { type: 'string' },
        run_in_background: { type: 'boolean' },
      },
    },
  }
  const fakeFileSystem = {
    async lstat(name, options) {
      const target = resolve(options?.cwd ?? workspace, name)
      if (!existsSync(target)) return undefined
      const stat = lstatSync(target)
      return {
        type: stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other',
        size: stat.size,
      }
    },
    async resolve(name, options) {
      return resolve(options?.cwd ?? workspace, name)
    },
    contains(parent, child) {
      const path = relative(parent, child)
      return path === '' || (!path.startsWith('..') && !isAbsolute(path))
    },
    processPath(target) {
      return target
    },
    async listDir(target) {
      return readdirSync(target, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name, 'en'))
        .map(entry => ({
          name: entry.name,
          type: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other',
          target: resolve(target, entry.name),
        }))
    },
    async readBytes(target, _signal, maximum) {
      const bytes = readFileSync(target)
      return new Uint8Array(bytes.subarray(0, maximum))
    },
  }
  const fakeTools = {
    register(definition) {
      definitions.set(definition.name, definition)
    },
    get(name) {
      return name === shellName ? shellSchema : definitions.get(name)
    },
    schemas() {
      return [...definitions.values(), shellSchema]
    },
    async execute(request) {
      const command = request.arguments.command
      const child = process.platform === 'win32'
        ? spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', command], { cwd: request.arguments.workdir, encoding: 'utf8' })
        : spawnSync('/bin/bash', ['-lc', command], { cwd: request.arguments.workdir, encoding: 'utf8' })
      if (child.error !== undefined) throw child.error
      const output = `${child.stdout ?? ''}${child.stderr ?? ''}`
      if (request.arguments.run_in_background === true) {
        const jobId = `${shellName}-1`
        jobRecords.set(jobId, {
          snapshot: {
            id: jobId,
            kind: shellName,
            label: command,
            status: 'completed',
            detail: `exit code: ${child.status ?? 1}`,
            startedAt: Date.now(),
            finishedAt: Date.now(),
            reported: false,
          },
          output,
        })
        return {
          isError: false,
          content: [{ type: 'text', text: `started background job ${jobId}` }],
          value: { kind: 'background', jobId },
        }
      }
      return {
        isError: false,
        content: [{ type: 'text', text: output }],
        value: { kind: 'foreground', exitCode: child.status ?? 1 },
      }
    },
  }
  const fakeJobs = {
    async wait(id) {
      return jobRecords.get(id).snapshot
    },
    get(id) {
      return jobRecords.get(id).snapshot
    },
    read(id) {
      const record = jobRecords.get(id)
      const text = record.output
      record.output = ''
      record.snapshot.reported = true
      return { text, snapshot: { ...record.snapshot } }
    },
  }
  projectOps.apply({ fs: fakeFileSystem, tools: fakeTools, jobs: fakeJobs })
  const owner = { id: 'project-ops-smoke-agent', session: { header: { cwd: workspace } } }
  const exec = {
    agent: owner,
    callId: 'project-ops-smoke',
    rootCallId: 'project-ops-smoke',
    token: {},
    signal,
  }
  const listed = await definitions.get('missher_project_ops_task_list').execute({}, exec)
  invariant(listed.tasks.length === 1, 'packed plugin did not discover exactly one temporary workspace task')
  const task = listed.tasks.find(candidate => candidate.id === 'package@packages/app:verify')
  invariant(task !== undefined, 'packed plugin did not discover the temporary workspace task')
  const planned = await definitions.get('missher_project_ops_task_plan').execute({
    changedFiles: ['packages/app/src/index.js'],
    goal: 'verify',
  }, exec)
  invariant(planned.tasks.some(candidate => candidate.id === task.id), 'packed plugin did not plan the affected workspace task')
  const result = await definitions.get('missher_project_ops_task_run').execute({
    taskId: task.id,
    manifestDigest: task.manifestDigest,
    mode: 'auto',
    waitMs: 100,
  }, exec)
  invariant(result.receipt.outcome === 'succeeded', `packed plugin receipt outcome was ${result.receipt.outcome}`)
  invariant(result.receipt.taskId === task.id, 'packed plugin receipt task id differs')
  invariant(result.receipt.executionMode === 'background', 'packed plugin did not use the existing background route')
  const gate = await definitions.get('missher_project_ops_verification_gate').execute({
    changedFiles: ['packages/app/src/index.js'],
    goal: 'verify',
    planDigest: planned.planDigest,
    receipts: [result.receipt],
  }, exec)
  invariant(gate.verdict === 'passed', `packed plugin verification gate was ${gate.verdict}`)
  invariant(existsSync(join(workspace, 'packages', 'app', 'project-ops-smoke.marker')), 'temporary workspace script did not execute')
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-project-ops-smoke-'))
const temporaryHome = join(temporaryRoot, 'home')
const packDir = join(temporaryRoot, 'pack')
const profile = 'project-ops-smoke'
const liveHome = join(homedir(), '.dsh')
const liveBefore = directorySentinel(liveHome)
const cli = [dshCli]
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const isolatedEnv = { ...process.env, DSH_HOME: temporaryHome }

try {
  mkdirSync(packDir)
  for (const required of [
    'LICENSE',
    'README.i18n.yaml',
    'README.md',
    'README.zh.md',
    'cordis.patch.yml',
    'lib/index.d.ts',
    'lib/index.js',
    'package.json',
  ]) {
    invariant(existsSync(join(pluginRoot, required)), `required package file is missing: ${required}`)
  }
  invariant(readFileSync(join(pluginRoot, 'cordis.patch.yml'), 'utf8') === expectedPatch, 'Bundle patch is not exact')

  const packed = JSON.parse(run(npmCommand, ['pack', '--json', '--pack-destination', packDir], {
    cwd: pluginRoot,
    shell: process.platform === 'win32',
  }))
  invariant(Array.isArray(packed) && packed.length === 1, 'npm pack returned an unexpected manifest')
  const archive = join(packDir, packed[0].filename)
  const entries = run('tar', ['-tzf', archive]).trim().split(/\r?\n/u).sort()
  invariant(JSON.stringify(entries) === JSON.stringify(expectedEntries), `archive entries differ from whitelist: ${entries.join(', ')}`)

  const archiveText = expectedEntries
    .filter(entry => !entry.endsWith('LICENSE'))
    .map(entry => run('tar', ['-xOf', archive, entry]))
    .join('\n')
  const forbidden = [
    pluginRoot,
    homedir(),
    'sourceMappingURL=',
    'BEGIN PRIVATE KEY',
  ]
  for (const value of forbidden) invariant(!archiveText.includes(value), `archive contains forbidden text: ${value}`)
  invariant(!/(?:api[_-]?key|authorization)\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}/i.test(archiveText), 'archive contains secret-shaped text')

  run(process.execPath, [...cli, 'plugin', '--profile', profile, 'add', archive], { env: isolatedEnv })
  const installed = readProfileManifest(temporaryHome, profile)
  invariant(installed.dependencies?.['dsh-project-ops'] !== undefined, 'temporary Profile dependency was not installed')
  invariant(installed.dsh?.profile?.bundles?.includes('dsh-project-ops'), 'temporary Profile Bundle layer was not activated')

  const dumped = run(process.execPath, [...cli, '--profile', profile, '--dump-config'], { env: isolatedEnv })
  invariant(dumped.includes('missher-project-ops'), 'temporary Profile did not compose the plugin row')

  const workspace = join(temporaryRoot, 'workspace')
  const runtimeRoot = join(temporaryRoot, 'runtime')
  mkdirSync(workspace)
  mkdirSync(runtimeRoot)
  run('tar', ['-xzf', archive, '-C', runtimeRoot])
  symlinkSync(
    join(pluginRoot, 'node_modules'),
    join(runtimeRoot, 'package', 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({
    name: 'project-ops-smoke-root',
    private: true,
    packageManager: 'npm@10.0.0',
    workspaces: ['packages/*'],
  }))
  mkdirSync(join(workspace, 'packages', 'app', 'src'), { recursive: true })
  writeFileSync(join(workspace, 'packages', 'app', 'src', 'index.js'), 'export {}\n')
  writeFileSync(join(workspace, 'packages', 'app', 'package.json'), JSON.stringify({
    name: '@smoke/app',
    private: true,
    scripts: {
      verify: 'node -e "require(\'node:fs\').writeFileSync(\'project-ops-smoke.marker\', \'ran\')"',
    },
  }))
  const profileDir = join(temporaryHome, 'profiles', profile)
  const installedEntry = join(profileDir, 'node_modules', 'dsh-project-ops', 'lib', 'index.js')
  const packedEntry = join(runtimeRoot, 'package', 'lib', 'index.js')
  invariant(
    createHash('sha256').update(readFileSync(installedEntry)).digest('hex')
      === createHash('sha256').update(readFileSync(packedEntry)).digest('hex'),
    'installed entry bytes differ from the packed entry',
  )
  await exercisePackedPlugin(packedEntry, workspace)

  run(process.execPath, [...cli, 'plugin', '--profile', profile, 'remove', 'dsh-project-ops'], { env: isolatedEnv })
  const removed = readProfileManifest(temporaryHome, profile)
  invariant(removed.dependencies?.['dsh-project-ops'] === undefined, 'temporary Profile dependency survived removal')
  invariant(!removed.dsh?.profile?.bundles?.includes('dsh-project-ops'), 'temporary Profile Bundle layer survived removal')
  invariant(directorySentinel(liveHome) === liveBefore, 'live ~/.dsh top-level sentinel changed')

  process.stdout.write('project-ops-smoke: PASS archive, isolated install, composition, workspace auto receipt, verification gate, removal, live-home sentinel\n')
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
