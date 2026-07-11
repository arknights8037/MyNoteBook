import { getCurrentWindow } from '@tauri-apps/api/window'
import { createApp, nextTick } from 'vue'

import App from './App.vue'
import './styles/global.css'
import { applyTheme, getThemePreference } from './services/theme'

applyTheme(getThemePreference())
performance.mark('notebook:vue-start')
createApp(App).mount('#app')
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
