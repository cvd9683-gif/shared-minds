import { defineConfig } from 'vite';

export default defineConfig({
  // Relative paths so the built app works from any folder (GitHub Pages, python -m http.server).
  base: './',
  server: {
    // Spotify no longer accepts "localhost" redirect URIs; use the loopback IP.
    host: '127.0.0.1',
    port: 5173,
    // If the browser can't call Genius directly (CORS), the app retries through here.
    proxy: {
      '/genius-api': {
        target: 'https://api.genius.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/genius-api/, ''),
      },
    },
  },
  build: {
    // Committed so the class index page can link straight to it without a build step.
    outDir: 'site',
    emptyOutDir: true,
  },
});
