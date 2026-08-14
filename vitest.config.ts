import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * 双项目配置(vitest 4 projects):
 * - main 项目:node 环境,覆盖 tests/main 主进程事实管道测试。
 * node:sqlite 需原生导入(jsdom/client 环境会尝试打包 node 内置而失败);
 * `new URL('./fixtures/...', import.meta.url)` 需保持 file: 解析(client
 * 环境会把 import.meta.url 改写为 jsdom location);且不加载 renderer setup
 * (localStorage/document 在 node 环境不存在)。
 * - renderer 项目(默认):jsdom + renderer DOM setup,覆盖 src/renderer 与
 * tests/(除 tests/main)。
 */
const alias = { '@': fileURLToPath(new URL('./src/renderer', import.meta.url)) };

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          environment: 'node',
          include: ['tests/main/**/*.test.ts'],
          globals: true,
          testTimeout: 10000,
          // 全局测试隔离:在测试文件加载前强制 LORRA_E2E_USERDATA 指向临时目录,
          // 任何 tests/main 测试都不可能触达生产 ~/.lorra(根因修复)。
          setupFiles: './tests/main/test-env-setup.ts',
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}', '!tests/main/**'],
          globals: true,
          setupFiles: './src/renderer/test-setup.ts',
          // 重型渲染测试(App.test/app-entry/providers-page/today-nav)在并行负载下
          // 偶发超过默认 5s(复审实证:单跑全过、复跑即绿),放宽到 10s
          testTimeout: 10000,
        },
      },
    ],
  },
});
