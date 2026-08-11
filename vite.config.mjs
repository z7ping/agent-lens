import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    open: false,
    proxy: {
      // 开发请求由 Vite 以 AgentLens 同源 Origin 转发，后端无需永久放宽 5173 跨域来源。
      '/api': proxyToBackend(),
      '/projects.json': proxyToBackend(),
      '/logs': proxyToBackend(),
      '/states': proxyToBackend(),
    },
  },
});

function proxyToBackend() {
  return {
    target: 'http://127.0.0.1:56789',
    changeOrigin: true,
    headers: { Origin: 'http://127.0.0.1:56789' },
  };
}
