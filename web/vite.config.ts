import { defineConfig } from 'vite';

const port = process.env.PORT || '3000';
export default defineConfig({
  server: {
    host: '127.0.0.1',
    proxy: {
      '/login': `http://127.0.0.1:${port}`,
      '/ws': { target: `ws://127.0.0.1:${port}`, ws: true },
    },
  },
});
