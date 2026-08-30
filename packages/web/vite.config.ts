import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// 与安装态 Runtime 的 56789 分离，确保单独启动 Vite 时也不会误连正式实例。
const runtimePort = Number(process.env.AGENT_LENS_DEV_API_PORT ?? 56800)
if (!Number.isInteger(runtimePort) || runtimePort < 1 || runtimePort > 65535) {
  throw new Error(`AGENT_LENS_DEV_API_PORT 必须是 1-65535 的整数，当前值：${String(process.env.AGENT_LENS_DEV_API_PORT)}`)
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    chunkSizeWarningLimit: 700,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': `http://127.0.0.1:${runtimePort}`,
    },
  },
})
