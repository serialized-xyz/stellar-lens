import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base "./" keeps every asset URL relative, so dist/ works from any path
// (GitHub Pages project sites included).
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  server: { port: 5173 },
  preview: { port: 4173 },
});
