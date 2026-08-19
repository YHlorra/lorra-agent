import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';

import { ensureDesktopViewport } from './desktop-viewport';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

/**
 * 技能管理页真机冒烟(2026-08-13 证明批,U1/U2/U3 可执行证据)。
 *
 * 隔离保证(与 app.spec.ts 同款):
 * - LORRA_E2E_USERDATA → mkdtemp 一次性目录(main.ts 把它设为 userData,
 * settings.json 落盘到隔离目录,不碰真实 %APPDATA%/lorra)。
 * - 工作区 = mkdtemp fixture(内建两个技能),收集根不动。
 * - 收尾删除临时目录;本测试永不带 LORRA_E2E_USERDATA 之外的路径进真实 home。
 *
 * 断言链:
 * U1 页面:进技能页 → 5 统计卡 + 两 fixture 行可见。
 * U2 开关:smoke-local on → 点击 → settings.json 落盘 workspaceSkillOverrides
 * 含该名(重启语义=名单持久化);smoke-off 种子停用 → 开关 off。
 * U3 弹层:点行名 → 详情弹层渲染描述文本。
 */
test.describe('技能管理页真机冒烟(隔离 profile)', () => {
  test('五卡渲染 / 行内开关落盘往返 / 详情弹层', async () => {
    test.setTimeout(180_000);
    const userData = await mkdtemp(path.join(tmpdir(), 'lorra-skills-e2e-'));
    const ws = await mkdtemp(path.join(tmpdir(), 'lorra-skills-ws-'));

    // fixture 技能 1:smoke-local(工作区源,启用态)。
    const localDir = path.join(ws, '.lorra', 'skills', 'smoke-local');
    await mkdir(localDir, { recursive: true });
    await writeFile(
      path.join(localDir, 'SKILL.md'),
      '---\nname: smoke-local\ndescription: 真机冒烟技能\n---\n\n# smoke\n',
      'utf8',
    );
    // fixture 技能 2:smoke-off(种子停用:workspaceSkillOverrides 预置)。
    const offDir = path.join(ws, '.lorra', 'skills', 'smoke-off');
    await mkdir(offDir, { recursive: true });
    await writeFile(
      path.join(offDir, 'SKILL.md'),
      '---\nname: smoke-off\ndescription: 停用技能\n---\n\n# off\n',
      'utf8',
    );
    await writeFile(
      path.join(userData, 'settings.json'),
      JSON.stringify(
        { recentWorkspaces: [ws], workspaceSkillOverrides: { [ws]: ['smoke-off'] } },
        null,
        2,
      ),
      'utf8',
    );

    const app = await electron.launch({
      args: [path.join(repoRoot, '.vite/build/main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PI_OFFLINE: '1',
        ANTHROPIC_AUTH_TOKEN: '',
        LORRA_E2E_USERDATA: userData,
      },
    });

    try {
      const win = await app.firstWindow({ timeout: 60_000 });
      await win.waitForLoadState('domcontentloaded');
      await ensureDesktopViewport(win);
      await win
        .getByRole('region', { name: '会话历史' })
        .waitFor({ state: 'visible', timeout: 60_000 });

      // U1:进技能页(nav.skills 于 2ab559b 改名「插件」:技能管理页并入插件页,
      // 默认 pane=skills;选择器随命名跟迁),5 统计卡 + 表格行。
      await win.getByRole('button', { name: '插件' }).click();
      await win.getByTestId('skills-page').waitFor({ timeout: 30_000 });
      await expect(win.locator('[data-testid="skills-hero-card"]')).toHaveCount(5);
      await expect(win.locator('[data-testid="skills-row"][data-name="smoke-local"]')).toBeVisible({
        timeout: 30_000,
      });
      await expect(win.locator('[data-testid="skills-row"][data-name="smoke-off"]')).toBeVisible();

      const toggle = win.locator(
        '[data-testid="skills-row"][data-name="smoke-local"] [data-testid="skills-toggle"]',
      );
      await expect(toggle).toBeChecked();
      // 真用户点击 label(checkbox 视觉隐藏,轨道拦截指针)——label 关联原生触发。
      await win.locator('[data-testid="skills-row"][data-name="smoke-local"] label.sk-tg').click();
      await expect
        .poll(
          async () => {
            const raw = await readFile(path.join(userData, 'settings.json'), 'utf8');
            const parsed = JSON.parse(raw) as {
              workspaceSkillOverrides?: Record<string, string[]>;
            };
            return parsed.workspaceSkillOverrides?.[ws]?.includes('smoke-local') ?? false;
          },
          { timeout: 15_000 },
        )
        .toBe(true);
      // 种子停用技能开关 = off(禁用语义往返的另一半)。
      await expect(
        win.locator(
          '[data-testid="skills-row"][data-name="smoke-off"] [data-testid="skills-toggle"]',
        ),
      ).not.toBeChecked();

      // U3:点行名 → 详情弹层渲染描述。
      await win
        .locator('[data-testid="skills-row"][data-name="smoke-local"] .sk-skill-name')
        .click();
      await expect(win.getByText('真机冒烟技能')).toBeVisible();

      // 视觉留证(工作区纪律:.smoke 内)。
      await win.screenshot({
        path: path.join(repoRoot, '.smoke', 'skills-e2e-final.png'),
        fullPage: true,
      });
    } finally {
      await app.close();
      await rm(userData, { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
    }
  });
});
