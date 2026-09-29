import { defineConfig } from 'vite';

export default defineConfig({
  // Relative paths so the built app works from any folder (GitHub Pages, python -m http.server).
  base: './',
  server: {
    // Spotify no longer accepts "localhost" redirect URIs; use the loopback IP.
    host: '127.0.0.1',
    port: 5173,
  },
  build: {
    // Committed so the class index page can link straight to it without a build step.
    outDir: 'site',
    emptyOutDir: true,
  },
});
