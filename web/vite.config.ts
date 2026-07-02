import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 需求管控台前端。构建产物落 web/dist，由后端 http server 静态托管（业务层，非 kernel
// workbench）。dev 时把 /api 代理到常驻进程的工作台端口（默认 127.0.0.1:7080），这样
// `npm run dev` 能直接吃真数据。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7090',
        changeOrigin: true,
      },
    },
  },
});
