import { createApp } from 'vue'
import 'katex/dist/katex.min.css'

import App from './App.vue'
import './styles/global.css'
import { applyTheme, getThemePreference } from './services/theme'

applyTheme(getThemePreference())
createApp(App).mount('#app')
