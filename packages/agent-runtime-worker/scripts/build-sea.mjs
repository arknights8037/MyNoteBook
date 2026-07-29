import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = resolve(packageRoot, '../..')
const dist = resolve(packageRoot, 'dist')
const bundle = resolve(dist, 'agent-runtime-worker.cjs')
const blob = resolve(dist, 'agent-runtime-worker.blob')
const executable = resolve(
  dist,
  process.platform === 'win32' ? 'agent-runtime-worker.exe' : 'agent-runtime-worker',
)

await mkdir(dist, { recursive: true })
run(
  'pnpm',
  [
    'exec',
    'esbuild',
    'src/main.ts',
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node22',
    `--outfile=${bundle}`,
  ],
  packageRoot,
)

const seaConfig = resolve(dist, 'sea-config.json')
await writeFile(
  seaConfig,
  JSON.stringify({
    main: bundle,
    output: blob,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
  }),
)
run(process.execPath, ['--experimental-sea-config', seaConfig], packageRoot)
await copyFile(process.execPath, executable)

const postjectArgs = [
  'exec',
  'postject',
  executable,
  'NODE_SEA_BLOB',
  blob,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
]
if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA')
run('pnpm', postjectArgs, packageRoot)

const targetTriple = run('rustc', ['--print', 'host-tuple'], workspaceRoot).stdout.trim()
if (!targetTriple) throw new Error('rustc did not return a host target triple')
const extension = process.platform === 'win32' ? '.exe' : ''
const sidecarTarget = resolve(
  workspaceRoot,
  `src-tauri/binaries/agent-runtime-worker-${targetTriple}${extension}`,
)
await mkdir(dirname(sidecarTarget), { recursive: true })
await copyFile(executable, sidecarTarget)

const smoke = spawnSync(executable, [], {
  cwd: packageRoot,
  encoding: 'utf8',
  input: [
    JSON.stringify({
      version: 1,
      type: 'runtime.hello',
      supervisorInstanceId: 'sea-build-smoke',
      protocolVersion: 1,
    }),
    JSON.stringify({ version: 1, type: 'shutdown', reason: 'SEA build smoke complete' }),
    '',
  ].join('\n'),
  timeout: 15_000,
})
if (smoke.status !== 0 || !smoke.stdout.includes('"type":"runtime.hello"')) {
  throw new Error(`sidecar smoke failed (${smoke.status}): ${smoke.stderr || smoke.stdout}`)
}
process.stdout.write(`${sidecarTarget}\n`)

function run(command, args, cwd) {
  const packageManagerScript = command === 'pnpm' ? process.env.npm_execpath : undefined
  const executableCommand = packageManagerScript ? process.execPath : command
  const executableArgs = packageManagerScript ? [packageManagerScript, ...args] : args
  const result = spawnSync(executableCommand, executableArgs, {
    cwd,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${result.error?.message || result.stderr || result.stdout}`,
    )
  }
  return result
}
