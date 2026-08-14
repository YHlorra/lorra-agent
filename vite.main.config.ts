import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

// Main process bundle — pure ESM. `package.json` declares "type": "module",
// so any stray `require` in the bundle fails at Electron load time with
// ReferenceError. The fixes:
// - `lib.formats: ['es']` — Rollup emits `import` not `require`
// - `inlineDynamicImports: true` — no top-level await
// - `external` covers Node built-ins (both `node:`-prefixed and bare names —
// bare names like `path` in CJS deps otherwise get rolldown's empty
// browser-external), Electron, and pi SDK so Node resolves them via real
// ESM imports at runtime.
export default defineConfig({
  build: {
    target: 'node20',
    minify: false,
    sourcemap: false,
    outDir: '.vite/build',
    emptyOutDir: false,
    lib: {
      entry: 'src/main.ts',
      formats: ['es'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      // 只留 electron 与 Node 内置(含无前缀名,如 CJS 依赖里的 require('path')):
      // 其余运行时依赖(pi SDK、electron-squirrel-startup)必须 bundle——
      // Forge Vite 插件打包时只拷 .vite/ 产物,node_modules 不进包。
      external: ['electron', /^node:/, ...builtinModules],
      output: {
        format: 'es',
        inlineDynamicImports: true,
        // rolldown 对 CJS 依赖生成的 __require("path") 等调用在 Electron ESM
        // 主进程无全局 require 会抛错;注入 createRequire 兜底。
        banner:
          "import { createRequire as __lorraCreateRequire } from 'node:module';\nglobalThis.require ??= __lorraCreateRequire(import.meta.url);",
      },
    },
  },
});
