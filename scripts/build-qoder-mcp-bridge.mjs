import { access, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = resolve(workspaceRoot, 'src-tauri/Cargo.toml')
const release = process.argv.includes('--release')
const targetTriple = run('rustc', ['--print', 'host-tuple'], workspaceRoot).stdout.trim()
if (!targetTriple) throw new Error('rustc did not return a host target triple')
const extension = process.platform === 'win32' ? '.exe' : ''
const bundled = resolve(
  workspaceRoot,
  `src-tauri/binaries/qoder-mcp-bridge-${targetTriple}${extension}`,
)
await mkdir(dirname(bundled), { recursive: true })
try {
  await access(bundled)
} catch {
  // Tauri validates externalBin paths in build.rs before this binary can be compiled.
  await writeFile(bundled, new Uint8Array())
}

const cargoArguments = [
  'build',
  '--manifest-path',
  manifest,
  '--bin',
  'qoder-mcp-bridge',
  ...(release ? ['--release'] : []),
]

run('cargo', cargoArguments, workspaceRoot)
const profile = release ? 'release' : 'debug'
const source = resolve(workspaceRoot, `src-tauri/target/${profile}/qoder-mcp-bridge${extension}`)
await copyFile(source, bundled)
process.stdout.write(`${bundled}\n`)

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
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
