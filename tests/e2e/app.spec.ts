import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';

import { ensureDesktopViewport } from './desktop-viewport';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
// 每 worker 独立 userData/workspace:CI 默认多 worker 并行,若共用同一目录,
// 并发测试的 rm -rf 会撞上另一测试正在运行的 Electron 锁定的 SQLite WAL
// (EBUSY)或清掉其数据目录,导致 shell 永不渲染(实测 --workers=2 复现)。
const userDataDir = () =>
  path.join(repoRoot, 'node_modules', `.lorra-e2e-userdata-${test.info().workerIndex}`);
const workspaceDir = () =>
  path.join(repoRoot, 'node_modules', `.lorra-e2e-workspace-${test.info().workerIndex}`);

/**
 * lorra E2E smoke — proves Electron loads main.js as ESM (no require errors)
 * and that the two spec-defined UI states render correctly:
 * - first launch (no workspace configured): the workspace picker dialog.
 * - second launch (workspace configured): the three-pane workspace shell.
 *
 * First launch shows the picker ONLY — the three-pane shell is the
 * CURRENT-WORKSPACE view and is not asserted here. The shell is
 * covered by the "second launch" test below, which seeds a settings.json
 * pointing at an existing workspace dir.
 *
 * LIMITATION: full prompt → stream → tool-roundtrip requires a real
 * pi-coding-agent provider which is not available in this offline env. Those
 * assertions live behind mocks in `tests/unit/*` instead.
 *
 * NOTE: Playwright's `app.evaluate(...)` callback runs in the Electron main
 * process context. With package.json "type": "module" the main process is
 * ESM, so the callback must use `import` not `require`. These tests
 * therefore write settings.json from the test runner process (Node fs) before
 * launching Electron rather than injecting it via the main process.
 */
test.describe('lorra e2e', () => {
  test('first launch: 自动创建默认工作区并进入工作台(无首启选择器)', async () => {
    test.setTimeout(120_000); // Electron cold start + dependency load can exceed 30s
    // Empty userData => no recentWorkspaces => main process auto-creates the
    // default workspace (~/.lorra/workspace under LORRA_E2E_USERDATA) and
    // activates it, so the shell renders instead of the old first-launch
    // picker dialog.
    const userData = userDataDir();
    await rm(userData, { recursive: true, force: true });
    await mkdir(userData, { recursive: true });

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
      const window = await app.firstWindow({ timeout: 60_000 });
      await window.waitForLoadState('domcontentloaded');
      await ensureDesktopViewport(window);

      // 首启选择器已取消:不出现在 DOM 中。
      await expect(window.getByRole('dialog', { name: '选择工作区' })).toHaveCount(0);
      // 三栏工作台直接渲染(会话历史 region 在左侧栏)。
      await expect(window.getByRole('region', { name: '会话历史' })).toBeVisible({
        timeout: 60_000,
      });
      await expect(window.getByRole('textbox', { name: '向 Agent 提问' })).toBeVisible();

      // 默认工作区目录已创建(~/.lorra/workspace 在隔离 userData 下)。
      // 测试进程有 node fs 权限,直接在测试侧 stat,避免跨进程 evaluate 类型问题。
      const defaultWs = path.join(userData, '.lorra', 'workspace');
      const st = await stat(defaultWs);
      expect(st.isDirectory()).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('provider setup offline: default model returns to the composer', async () => {
    test.setTimeout(120_000);
    const userData = userDataDir();
    const workspace = workspaceDir();
    await rm(userData, { recursive: true, force: true });
    await mkdir(userData, { recursive: true });
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(userData, 'settings.json'),
      JSON.stringify({ recentWorkspaces: [workspace] }, null, 2),
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
      const window = await app.firstWindow({ timeout: 60_000 });
      await window.waitForLoadState('domcontentloaded');
      await window
        .getByRole('button', { name: /^(连接模型|打开模型供应商配置)$/ })
        .first()
        .click();
      await expect(window.getByRole('heading', { name: '连接供应商' })).toBeVisible();

      const anthropic = window
        .locator('.pc-provider-row')
        .filter({ has: window.getByText('Anthropic', { exact: true }) });
      await expect(anthropic).toBeVisible();
      await anthropic.getByRole('button', { name: '连接' }).click();
      await expect(window.getByRole('heading', { name: 'Anthropic' })).toBeVisible();
      await window.getByLabel('API Key').fill('sk-ant-e2e-not-a-real-key');
      await window.getByRole('button', { name: '连接', exact: true }).click();

      const models = window.locator('.pc-model-row');
      await expect(models.first()).toBeVisible();
      const modelName = (await models.first().locator('.pc-model-name').textContent())?.trim();
      expect(modelName).toBeTruthy();

      const setDefault = models.first().getByRole('button', { name: '设为默认' });
      if (await setDefault.isVisible()) await setDefault.click();

      await window.getByRole('button', { name: '完成' }).click();
      await window.getByRole('button', { name: '返回工作区' }).click();
      // 2026-08-19 模型胶囊改版:composer-model-name 已被常驻按钮取代,按钮文本
      // = 模型名 + chevron(svg 无文本),用 containText 匹配。
      await expect(window.locator('.composer-model-button')).toContainText(modelName as string);
    } finally {
      await app.close();
    }
  });

  test('narrow viewport: composer input remains visible in 800×600 window', async () => {
    test.setTimeout(120_000);
    const userData = userDataDir();
    const workspace = workspaceDir();
    await rm(userData, { recursive: true, force: true });
    await mkdir(userData, { recursive: true });
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(userData, 'settings.json'),
      JSON.stringify({ recentWorkspaces: [workspace] }, null, 2),
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
      const window = await app.firstWindow({ timeout: 60_000 });
      await window.waitForLoadState('domcontentloaded');
      await window.setViewportSize({ width: 800, height: 600 });
      await expect(window.getByRole('textbox', { name: '向 Agent 提问' })).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('long file: file tree remains reachable after the document opens', async () => {
    test.setTimeout(120_000);
    const userData = userDataDir();
    const workspace = workspaceDir();
    await rm(userData, { recursive: true, force: true });
    await mkdir(userData, { recursive: true });
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(workspace, 'long.md'),
      Array.from({ length: 240 }, (_, index) => `line ${index + 1}: long document content`).join(
        '\n',
      ),
      'utf8',
    );
    await writeFile(
      path.join(userData, 'settings.json'),
      JSON.stringify({ recentWorkspaces: [workspace] }, null, 2),
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
      const window = await app.firstWindow({ timeout: 60_000 });
      await window.waitForLoadState('domcontentloaded');
      await ensureDesktopViewport(window);

      const fileRow = window.getByRole('treeitem', { name: 'long.md' });
      // 视口从窄切宽触发侧栏重挂载,CI 上可能超默认 5s。
      await expect(fileRow).toBeVisible({ timeout: 30_000 });
      await fileRow.click();
      await expect(window.locator('.document-content')).toContainText('line 240');

      await expect(fileRow).toBeInViewport();
    } finally {
      await app.close();
    }
  });

  test('long chat: messages scroll while the composer remains inside the pane', async () => {
    test.setTimeout(120_000);
    const userData = userDataDir();
    const workspace = workspaceDir();
    await rm(userData, { recursive: true, force: true });
    await mkdir(userData, { recursive: true });
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(userData, 'settings.json'),
      JSON.stringify({ recentWorkspaces: [workspace] }, null, 2),
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
      const window = await app.firstWindow({ timeout: 60_000 });
      await window.waitForLoadState('domcontentloaded');
      await window.setViewportSize({ width: 1200, height: 700 });
      await expect(window.getByRole('textbox', { name: '向 Agent 提问' })).toBeVisible();

      const metrics = await window.evaluate(() => {
        const pane = document.querySelector<HTMLElement>('.chat-pane');
        const stream = document.querySelector<HTMLElement>('.chat-stream');
        const composer = document.querySelector<HTMLElement>('.composer-region');
        if (!pane || !stream || !composer) throw new Error('chat layout missing');
        for (let index = 0; index < 40; index += 1) {
          const message = document.createElement('div');
          message.className = 'message assistant';
          message.textContent = `Long assistant response ${index + 1}`;
          stream.append(message);
        }
        const paneRect = pane.getBoundingClientRect();
        const composerRect = composer.getBoundingClientRect();
        return {
          streamClientHeight: stream.clientHeight,
          streamScrollHeight: stream.scrollHeight,
          paneBottom: paneRect.bottom,
          composerBottom: composerRect.bottom,
        };
      });

      expect(metrics.streamScrollHeight).toBeGreaterThan(metrics.streamClientHeight);
      // 浮点亚像素容差:getBoundingClientRect 底部边界在缩放/DPI 下可差 1e-5px
      // (2026-08-09 flaky 实证:700.31750488 > 700.31747436),断言加 0.1px 容差。
      expect(metrics.composerBottom).toBeLessThanOrEqual(metrics.paneBottom + 0.1);
    } finally {
      await app.close();
    }
  });

  test('second launch (workspace configured): shell renders', async () => {
    test.setTimeout(120_000);
    const userData = userDataDir();
    const workspace = workspaceDir();
    // Clean slate for both the isolated userData and the workspace dir.
    await rm(userData, { recursive: true, force: true });
    await mkdir(userData, { recursive: true });
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });

    // Seed settings.json with one existing workspace so the app skips the
    // picker and renders the three-pane workspace shell .
    // Shape: src/main/workspace/settings.ts AppSettings { recentWorkspaces: string[] }.
    await writeFile(
      path.join(userData, 'settings.json'),
      JSON.stringify({ recentWorkspaces: [workspace] }, null, 2),
      'utf8',
    );

    const app = await electron.launch({
      args: [path.join(repoRoot, '.vite/build/main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        LORRA_E2E_USERDATA: userData,
      },
    });

    const window = await app.firstWindow({ timeout: 60_000 });
    await window.waitForLoadState('domcontentloaded');
    await ensureDesktopViewport(window);

    // Shell regions render whenever a workspace path is set, independent of
    // driver init success (driver failures are caught and logged in main.ts).
    await expect(window.getByRole('region', { name: '会话历史' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(window.getByRole('tree', { name: '文件树' })).toBeVisible();
    await expect(window.getByRole('main', { name: '当前文档' })).toBeVisible();
    await expect(window.getByRole('region', { name: 'Agent 对话' })).toBeVisible();

    await app.close();
  });

  // : 主题与图标栏折叠偏好(lorra-ui)跨重启持久化。
  // 第一次启动切深色 + 折叠 → 第二次启动(同一 userData)断言两者保留。
  test('theme + nav collapse persist across relaunch', async () => {
    test.setTimeout(120_000);
    const userData = userDataDir();
    const workspace = workspaceDir();
    await rm(userData, { recursive: true, force: true });
    await mkdir(userData, { recursive: true });
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(userData, 'settings.json'),
      JSON.stringify({ recentWorkspaces: [workspace] }, null, 2),
      'utf8',
    );

    const launch = async () =>
      electron.launch({
        args: [path.join(repoRoot, '.vite/build/main.js')],
        env: {
          ...process.env,
          NODE_ENV: 'test',
          LORRA_E2E_USERDATA: userData,
        },
      });

    // 第一次启动:切深色 + 折叠图标栏。
    let app = await launch();
    let window = await app.firstWindow({ timeout: 60_000 });
    await window.waitForLoadState('domcontentloaded');
    await expect(window.getByRole('textbox', { name: '向 Agent 提问' })).toBeVisible();

    await window.getByRole('button', { name: '切换深色模式' }).click();
    await expect
      .poll(() => window.evaluate(() => document.documentElement.classList.contains('dark')))
      .toBe(true);

    await window.getByRole('button', { name: '折叠图标栏' }).click();
    await expect(window.getByRole('navigation', { name: '页面导航' })).toBeHidden();
    await app.close();

    // 第二次启动(同一 userData):深色与折叠都应保留。
    app = await launch();
    window = await app.firstWindow({ timeout: 60_000 });
    await window.waitForLoadState('domcontentloaded');
    await expect(window.getByRole('textbox', { name: '向 Agent 提问' })).toBeVisible();

    expect(await window.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(
      true,
    );
    await expect(window.getByRole('navigation', { name: '页面导航' })).toBeHidden();
    await expect(window.getByRole('button', { name: '切换浅色模式' })).toBeVisible();
    await expect(window.getByRole('button', { name: '展开图标栏' })).toBeVisible();

    await app.close();
  });

  // 斜杠命令(pi TUI):/new 回车执行并清空;未知命令显示提示且保留输入。
  // (compact 需真实模型汇总,离线 e2e 不覆盖;见 )
  test('slash commands: /new executes, unknown /foo shows hint', async () => {
    test.setTimeout(120_000);
    const userData = userDataDir();
    const workspace = workspaceDir();
    await rm(userData, { recursive: true, force: true });
    await mkdir(userData, { recursive: true });
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(userData, 'settings.json'),
      JSON.stringify({ recentWorkspaces: [workspace] }, null, 2),
      'utf8',
    );

    const app = await electron.launch({
      args: [path.join(repoRoot, '.vite/build/main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        LORRA_E2E_USERDATA: userData,
      },
    });

    try {
      const window = await app.firstWindow({ timeout: 60_000 });
      await window.waitForLoadState('domcontentloaded');
      const composer = window.getByRole('textbox', { name: '向 Agent 提问' });
      await expect(composer).toBeVisible();

      // /new → 执行(新会话)且输入清空,不发给 AI。
      await composer.fill('/new');
      await composer.press('Enter');
      await expect(composer).toHaveValue('');

      // 未知命令 → 提示条 + 输入保留。
      await composer.fill('/foo');
      await composer.press('Enter');
      await expect(window.getByText(/未识别的命令：\/foo/)).toBeVisible();
      await expect(composer).toHaveValue('/foo');
    } finally {
      await app.close();
    }
  });

  // End-to-end regression for the historical session feature (covers both
  // fix layers + the attachWindow fix + EventMapper.replayFromMessages).
  // Pre-seeds current and historical JSONL sessions at the SDK discovery path that lorra actually
  // writes to (lorraConfigDir/sessions/--cwd--/...), launches the app, and
  // asserts the sidebar surfaces it + click opens with replayed messages.
  test('seed past session: sidebar lists it + click opens + replays history', async () => {
    test.setTimeout(120_000);
    const userData = userDataDir();
    const workspace = workspaceDir();
    await rm(userData, { recursive: true, force: true });
    await mkdir(userData, { recursive: true });
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(userData, 'settings.json'),
      JSON.stringify({ recentWorkspaces: [workspace] }, null, 2),
      'utf8',
    );

    // Pre-seed JSONL sessions under lorra's config dir — exactly where
    // lorra's persistence writes (after fix session-persistence
    // passes sessionDir=lorraConfigDir/sessions/--cwd--/ to all
    // SessionManager.* calls, matching buildAgentSession's agentDir).
    const agentDir = path.join(userData, '.lorra');
    const safe = `--${workspace.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
    const sessionsRoot = path.join(agentDir, 'sessions', safe);
    await mkdir(sessionsRoot, { recursive: true });
    const sessionId = 'e2e-past-1';
    const sessionFile = path.join(sessionsRoot, `${sessionId}.jsonl`);
    const header = {
      type: 'session',
      version: 1,
      id: sessionId,
      timestamp: '2026-07-29T10:00:00Z',
      cwd: workspace,
    };
    const userEntry = {
      type: 'message',
      id: 'msg-1',
      parentId: null,
      timestamp: '2026-07-29T10:00:00Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '历史提问：检查 lorra 发送链路' }],
        timestamp: new Date('2026-07-29T10:00:00Z').getTime(),
      },
    };
    const assistantEntry = {
      type: 'message',
      id: 'msg-2',
      parentId: 'msg-1',
      timestamp: '2026-07-29T10:00:05Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '已读消息，等待用户追问。' }],
        timestamp: new Date('2026-07-29T10:00:05Z').getTime(),
      },
    };
    await writeFile(
      sessionFile,
      `${JSON.stringify(header)}\n${JSON.stringify(userEntry)}\n${JSON.stringify(assistantEntry)}\n`,
      'utf8',
    );
    await writeFile(
      path.join(sessionsRoot, 'e2e-current.jsonl'),
      `${JSON.stringify({
        ...header,
        id: 'e2e-current',
        timestamp: '2026-07-29T11:00:00Z',
      })}\n${JSON.stringify({
        ...userEntry,
        id: 'msg-current',
        timestamp: '2026-07-29T11:00:00Z',
        message: {
          ...userEntry.message,
          content: [{ type: 'text', text: '当前会话占位' }],
          timestamp: new Date('2026-07-29T11:00:00Z').getTime(),
        },
      })}\n`,
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
      const window = await app.firstWindow({ timeout: 60_000 });
      await window.waitForLoadState('domcontentloaded');
      await ensureDesktopViewport(window);
      await expect(window.getByRole('region', { name: '会话历史' })).toBeVisible({
        timeout: 30_000,
      });

      // Sidebar reads lorra.session.list on workspace mount and lists rows
      // by firstMessage. If SDK list/read path is wrong or the
      // attachWindow bus isn't wired (regression), this row is missing.
      const row = await window
        .getByRole('region', { name: '会话历史' })
        .getByRole('button', { name: /历史提问：检查 lorra 发送链路/ })
        .first();
      await expect(row).toBeVisible({ timeout: 15_000 });

      // Clicking drives lorra.session.open with the seeded id;
      // driver.attachSessionSubscription then replays handle.messages via
      // EventMapper → router → lorra.events → renderer ChatRow renders
      // role=user + role=assistant.
      await row.click();
      const userRow = window.locator('.message.user', {
        hasText: '历史提问：检查 lorra 发送链路',
      });
      const assistantRow = window.locator('.message.assistant', {
        hasText: '已读消息，等待用户追问。',
      });
      await expect(userRow).toBeVisible({ timeout: 15_000 });
      await expect(assistantRow).toBeVisible({ timeout: 15_000 });
    } finally {
      await app.close();
    }
  });

  // Real-Electron integration check: shell.trashItem actually moves files
  // outside the Vitest sandbox. Covers the "file moves to OS Recycle Bin"
  // half of spec tool-safety-interceptor:40-47 + . The other half —
  // "interceptor rewrites `rm <file>` to trashItem" — stays in unit tests
  // where the rm-detection logic is pure and mockable.
  test('shell.trashItem moves a real file (no mocks)', async () => {
    test.setTimeout(60_000);

    const app = await electron.launch({
      args: [path.join(repoRoot, '.vite/build/main.js')],
      env: { ...process.env, NODE_ENV: 'test' },
    });

    try {
      const tmp = await mkdtemp(path.join(tmpdir(), 'lorra-e2e-trash-'));
      const file = path.join(tmp, 'file.md');
      await writeFile(file, 'hello bytes');

      // Real Electron call — moves to OS Recycle Bin (Windows/macOS) or
      // unlinks (Linux CI without a Trash API). Runs inside Electron's main
      // process because Playwright's `app.evaluate` cannot use dynamic
      // import — only string payloads survive serialization. fs ops stay
      // in the test process (Node).
      const result = await app.evaluate(
        async (
          { shell }: { shell: { trashItem(path: string): Promise<void> } },
          filePath: string,
        ) => {
          await shell.trashItem(filePath);
          return true;
        },
        file,
      );
      expect(result).toBe(true);

      let stillExists = true;
      try {
        await stat(file);
      } catch (err) {
        if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
          stillExists = false;
        } else throw err;
      }
      expect(stillExists).toBe(false);

      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    } finally {
      await app.close();
    }
  });

  // Regression: contextBridge strips class methods off Result instances, so
  // the renderer must receive a plain {ok, value, error} envelope. Without
  // this, every .isOk in src/renderer/*.tsx throws at module evaluation
  // (vite `[Unhandled rejection] TypeError: continued.isOk is not a function`).
  // This test launches a real Electron app, exercises one IPC method that
  // produces an Err envelope (no driver — proves the shape is whatever the
  // bridge surfaces, not whatever mocks return), and asserts the final shape.
  test('ipc envelope arrives across contextBridge as plain {ok, value?, error?}', async () => {
    test.setTimeout(120_000);
    const userData = userDataDir();
    const workspace = workspaceDir();
    await rm(userData, { recursive: true, force: true });
    await mkdir(userData, { recursive: true });
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(userData, 'settings.json'),
      JSON.stringify({ recentWorkspaces: [workspace] }, null, 2),
      'utf8',
    );

    const app = await electron.launch({
      args: [path.join(repoRoot, '.vite/build/main.js')],
      env: { ...process.env, NODE_ENV: 'test', LORRA_E2E_USERDATA: userData },
    });

    try {
      const window = await app.firstWindow({ timeout: 60_000 });
      await window.waitForLoadState('domcontentloaded');

      // Use a method that wraps the result path (session.continueRecent would
      // crash bootstrap if .isOk were broken — we'd never reach this probe).
      // providers.list returns SerializedResult<ConnectedProviderDto[]>; with
      // no provider configured it produces a well-defined envelope.
      const probe = await window.evaluate(async () => {
        const r = await (
          window as unknown as { lorra: { providers: { list: () => Promise<unknown> } } }
        ).lorra.providers.list();
        return {
          isOkFn: typeof (r as { isOk?: unknown }).isOk === 'function',
          hasOkField: 'ok' in (r as Record<string, unknown>),
          okValue: (r as { ok?: unknown }).ok,
          hasStatusField: 'status' in (r as Record<string, unknown>),
          keys: Object.keys(r as object),
          proto: Object.getPrototypeOf(r)?.constructor?.name ?? null,
        };
      });

      expect(probe.isOkFn).toBe(false);
      expect(probe.hasStatusField).toBe(false);
      expect(probe.hasOkField).toBe(true);
      expect(typeof probe.okValue).toBe('boolean');
    } finally {
      await app.close();
    }
  });
});
