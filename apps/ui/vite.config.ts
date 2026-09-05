import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The UI talks to the API through this proxy in dev, so there is one origin
    // and no CORS configuration to get wrong.
    proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') } },
  },
});
