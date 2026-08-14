import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const rendererDir = path.dirname(fileURLToPath(import.meta.url));

// Renderer runs in Chromium — ESM. Electron Forge + Vite Plugin normally
// manages the renderer build; this config is the standalone fallback for
// ad-hoc rebuilds. Output dir matches the Electron Forge Vite Plugin default
// (.vite/renderer/<name>/) so the main process can loadFile the built index.html.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(rendererDir, 'src/renderer'),
    },
  },
  // Relative base so the built index.html references assets as ./assets/...
  // instead of /assets/... . Under Electron's loadFile (file:// protocol),
  // absolute paths resolve to the drive root (ERR_FILE_NOT_FOUND) and the
  // renderer bundle never loads — React never mounts, the first-launch
  // workspace picker never appears. Relative base resolves against the
  // HTML's own directory (.vite/renderer/main_window/) so assets load.
  base: './',
  // Dev server binds IPv4 loopback explicitly. Without this, vite defaults to
  // `localhost` which on IPv6-enabled Windows resolves to ::1 — Electron's
  // loadURL('http://localhost:5173/') then hits 127.0.0.1 and gets
  // ERR_CONNECTION_REFUSED (address-family mismatch, blank window every start).
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  build: {
    target: 'chrome128',
    minify: false,
    sourcemap: false,
    outDir: '.vite/renderer/main_window',
    emptyOutDir: false,
  },
});
