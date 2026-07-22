import { getCurrentWindow } from '@tauri-apps/api/window'
import { createApp, nextTick } from 'vue'

import App from './App.vue'
import { ASSET_PORT_KEY } from '@/editor/core/assetPortContext'
import { tauriAssetService } from './infrastructure/assets/AssetService'
import './styles/global.css'
import { applyTheme, getThemePreference } from '@/services/appearance/theme'

applyTheme(getThemePreference())
performance.mark('notebook:vue-start')
createApp(App).provide(ASSET_PORT_KEY, tauriAssetService).mount('#app')
performance.mark('notebook:vue-mounted')

async function revealMainWindow(): Promise<void> {
  await nextTick()
  await Promise.race([
    new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    new Promise<void>((resolve) => globalThis.setTimeout(resolve, 100)),
  ])

  if (Reflect.has(globalThis, '__TAURI_INTERNALS__')) {
    await getCurrentWindow().show()
  }

  performance.mark('notebook:window-visible')
}

void revealMainWindow().catch((error: unknown) => {
  globalThis.console.error('Failed to reveal the main window.', error)
})
