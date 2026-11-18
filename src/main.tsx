import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import { hydrateApiKey } from './services/settings.js'
import './app/theme.css'
import './app/global.css'

ensureKatex()
setupTheme()

// 原生侧先从 Keystore 恢复 API Key 再渲染，避免首屏误判未配置 Key
void hydrateApiKey().finally(() => {
  createRoot(document.getElementById('root') as HTMLElement).render(<App />)
})
