import { invoke } from '@tauri-apps/api/core'

import type { LocalEnvironmentSnapshot } from '@/models/integrations/localEnvironment'

export async function getLocalEnvironmentSnapshot(): Promise<LocalEnvironmentSnapshot> {
  return invoke<LocalEnvironmentSnapshot>('get_local_environment_snapshot')
}
