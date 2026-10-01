import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // GENIUS_TOKEN (no VITE_ prefix) stays on the dev server and is never put in the bundle.
  const geniusToken = loadEnv(mode, process.cwd(), '').GENIUS_TOKEN ?? '';
  return {
    define: {
      // Shown in the ⋯ menu, so you can tell which version is running.
      __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
      __GENIUS_DEV__: JSON.stringify(mode === 'development' && !!geniusToken),
    },
    // Relative paths so the built app works from any folder (GitHub Pages, python -m http.server).
    base: './',
    server: {
      // Spotify no longer accepts "localhost" redirect URIs; use the loopback IP.
      host: '127.0.0.1',
      port: 5173,
      // The browser can't call Genius directly (CORS), so the dev server passes requests on,
      // adding GENIUS_TOKEN from .env.local when the request doesn't carry its own token.
      proxy: {
        '/genius-api': {
          target: 'https://api.genius.com',
          changeOrigin: true,
          rewrite: (path) => {
            const p = path.replace(/^\/genius-api/, '');
            if (!geniusToken || p.includes('access_token=')) return p;
            return `${p}${p.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(geniusToken)}`;
          },
        },
      },
    },
    build: {
      // Committed so the class index page can link straight to it without a build step.
      outDir: 'site',
      emptyOutDir: true,
    },
  };
});
