import { defineConfig } from 'vite';

// Preload runs in Electron's preload context which expects CJS — Electron's
// preload loader does not (yet) support ESM. So preload stays CJS.
export default defineConfig({
  build: {
    target: 'node18',
    minify: false,
    sourcemap: false,
    outDir: '.vite/build',
    emptyOutDir: false,
    lib: {
      entry: 'src/preload.ts',
      formats: ['cjs'],
      fileName: () => 'preload.js',
    },
    rollupOptions: {
      external: ['electron'],
      output: {
        format: 'cjs',
        inlineDynamicImports: true,
      },
    },
  },
});
