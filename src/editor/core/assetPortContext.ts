import type { InjectionKey } from 'vue'

import type { AssetPort } from '@/services/ports/AssetPort'

export const ASSET_PORT_KEY: InjectionKey<AssetPort> = Symbol('AssetPort')
