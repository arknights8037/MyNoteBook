import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import type { CliAgentFilePort } from '@/services/CliAgentAdapter'

export const tauriCliAgentFilePort: CliAgentFilePort = {
  readTextFile,
  writeTextFile,
}
