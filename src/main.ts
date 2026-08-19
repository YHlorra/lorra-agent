import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, shell } from 'electron';
import started from 'electron-squirrel-startup';
import { setMainLanguage } from './main/i18n';
import { registerClipboardHandlers } from './main/ipc/clipboard-ipc';
import { registerEditsHandlers } from './main/ipc/edits-ipc';
import { registerFsHandlers } from './main/ipc/fs-ipc';
import { registerMemoryIpc } from './main/ipc/memory-ipc';
import { registerModelHandlers } from './main/ipc/model-ipc';
import { registerAgentPluginsIpc, registerPluginsHandlers } from './main/ipc/plugins-ipc';
import { registerReviewHandlers } from './main/ipc/review-ipc';
import { registerSessionHandlers } from './main/ipc/session-ipc';
import { registerSettingsHandlers } from './main/ipc/settings-ipc';
import { registerSkillsIpc } from './main/ipc/skills-ipc';
import { registerTodayHandlers } from './main/ipc/today-ipc';
import { registerWindowHandlers } from './main/ipc/window-ipc';
import { isExternalUrl } from './main/lib/external-url';
import { seedPluginTemplate } from './main/ofk/plugin-template-seed';
import { ModelConfigAdapter } from './main/pi-sdk-driver/model-config';
import { installUncaughtHandlers } from './main/pi-sdk-driver/uncaught-handler';
import { seedBuiltinSkills } from './main/skills/builtin-skill-seeder';
import { registerWorkspaceHandlers } from './main/workspace/ipc';
import { createWorkspaceRuntime, type WorkspaceRuntime } from './main/workspace/runtime';
import { readSettings } from './main/workspace/settings';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;
// Electron Forge's Vite Plugin injects both MAIN_WINDOW_VITE_NAME and
// MAIN_WINDOW_VITE_DEV_SERVER_URL at build time. When the bundle is built
// outside forge (manual `vite build`), the constants are undefined;
// fall back to the conventional name + empty URL so loadFile finds the
// renderer output (.vite/renderer/main_window/index.html) and loadURL is
// skipped .
// pi-ai 前缀缓存 TTL 档位:'long' = 1h(MiniMax anthropic-messages 网关实现
// cache_control 契约)。提取器与主对话的稳定前缀跨请求命中,降首 token 延迟;
// getProviderEnvValue 每次请求动态读 env,此处设置对后续所有 SDK 请求生效。
process.env.PI_CACHE_RETENTION = 'long';

const MAIN_WINDOW_NAME: string =
  typeof MAIN_WINDOW_VITE_NAME !== 'undefined' && MAIN_WINDOW_VITE_NAME
    ? MAIN_WINDOW_VITE_NAME
    : 'main_window';
const MAIN_WINDOW_DEV_URL: string =
  typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined' && MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? MAIN_WINDOW_VITE_DEV_SERVER_URL
    : '';

// Test-only hook: lets Playwright isolate userData (inactive unless LORRA_E2E_USERDATA is set).
if (process.env.LORRA_E2E_USERDATA) {
  app.setPath('userData', process.env.LORRA_E2E_USERDATA);
}

if (started) app.quit();

// ESM equivalent of CJS __dirname; required because pi SDK is pure ESM and the
// main bundle is built as `formats: ['es']` (see vite.main.config.ts).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Section 1.5: smoke-load the pure-ESM pi-coding-agent at startup so that
// bundling / interop regressions surface immediately (e.g. ERR_REQUIRE_ESM).
// The result is held only to keep the module alive — driver wiring lives in
// src/main/pi-sdk-driver/* and is added by Section 4 tasks.
void import('@earendil-works/pi-coding-agent');

// : install uncaught exception handlers before the app is ready.
// Per R-E: log only, do NOT restart.
installUncaughtHandlers();

// Module-scoped so before-quit handler can reach it without re-resolving
// through any cycle; runtime is the single source of truth for the active
// driver.
let runtime: WorkspaceRuntime | undefined;

// Dev-mode startup race: electron-forge launches the window before the vite
// renderer dev server binds its port, so the first loadURL hits
// ERR_CONNECTION_REFUSED and the window stays blank. Wait (bounded) for the
// dev server to answer before loading.
async function loadDevWindow(window: BrowserWindow): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(MAIN_WINDOW_DEV_URL);
      if (res.ok) break;
    } catch {
      // server not up yet
    }
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await window.loadURL(MAIN_WINDOW_DEV_URL);
}

function createWindow() {
  // lorra 应用图标(2026-08-18 用户指定:白发蓝瞳动漫少女,见 build/icon-source.jpg)。
  // 开发期:相对源码根 build/icon.ico。打包后:forge extraResource 把 build/icon.ico
  // 复制到 resources/icon.ico(旧注释的 resources/build/icon.ico 已失效,
  // Forge Vite 插件只打包 .vite + package.json)。
  // 路径解析失败则忽略(Electron 用 exe 内嵌图标,不阻塞启动)。
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '..', '..', 'build', 'icon.ico');
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 600,
    frame: false,
    backgroundColor: '#fbfaf6',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (MAIN_WINDOW_DEV_URL) {
    void loadDevWindow(window);
  } else {
    void window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_NAME}/index.html`));
  }
  // 外部链接一律系统浏览器打开,拒绝新 Electron 窗口(开源项目页仓库/包地址
  // 链接均走此路径;协议白名单 http/https/mailto 详见 src/main/lib/external-url.ts)。
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Bridge the renderer to the active driver so agent events flow back.
  // The runtime rebinds automatically when a workspace switch rebuilds the
  // driver (see workspace/runtime.ts). Calling on a null runtime is a noop
  // — useful during the very first frame before app.whenReady resolves.
  runtime?.attachWindow(window.webContents);
  return window;
}

const unavailableModelConfig = () => ({
  ok: false as const,
  code: 'model-config-unavailable',
  message: 'model config unavailable',
});

app.whenReady().then(async () => {
  // :插件目录播种(README + 模板;write-if-missing,失败静默)。
  seedPluginTemplate();
  // 内置技能盘(2026-08-18):首次写 ~/.lorra/skills/,lorra 升级新增内置 .md 也会自动落盘;
  // write-if-missing(用户编辑过不覆写),失败静默,详见 builtin-skill-seeder.ts 注释。
  seedBuiltinSkills();
  const settings = await readSettings();
  // :main 进程语言真源与 renderer 同源(settings.json),启动即同步。
  setMainLanguage(settings.language ?? 'zh');
  const initialWsPath = settings.recentWorkspaces[0] ?? null;

  runtime = createWorkspaceRuntime();

  registerWorkspaceHandlers(runtime);
  registerFsHandlers({ getActiveWorkspacePath: () => runtime?.getActivePath() ?? null });
  registerClipboardHandlers({ getActiveWorkspacePath: () => runtime?.getActivePath() ?? null });
  registerSessionHandlers(() => runtime?.getActiveDriver() ?? null);
  registerEditsHandlers(() => runtime?.getActiveDriver() ?? null);
  registerSettingsHandlers();
  registerWindowHandlers();
  registerPluginsHandlers();
  registerAgentPluginsIpc();
  registerTodayHandlers();
  registerReviewHandlers(() => runtime?.getActivePath() ?? null);
  // 6.13 消化/结晶按工作区落候选:getter 取当前活跃路径(切换后仍取最新)。
  registerMemoryIpc({
    getActiveWorkspacePath: () => runtime?.getActivePath() ?? null,
    getActiveDriver: () => runtime?.getActiveDriver() ?? null,
  });
  // 技能管理(V1):xray 全量 / 全局启停 / 悬空清理,resolveWorkspacePath
  // 内部回退当前工作区(recentWorkspaces 首个,workspace/ipc.ts 同口径)。
  registerSkillsIpc();

  let modelConfig: ModelConfigAdapter | undefined;
  try {
    modelConfig = await ModelConfigAdapter.create({
      workspaceCwd: initialWsPath ?? process.cwd(),
    });
  } catch (error) {
    console.error('ModelConfigAdapter init failed:', error);
  }
  registerModelHandlers(
    modelConfig ??
      ({
        catalog: () => [],
        listConnected: () => [],
        connect: unavailableModelConfig,
        disconnect: unavailableModelConfig,
        customAdd: unavailableModelConfig,
        customRemove: unavailableModelConfig,
        listModels: () => [],
        getDefault: () => null,
        setDefault: unavailableModelConfig,
        toggleModel: unavailableModelConfig,
        getAvailable: () => [],
      } as unknown as ModelConfigAdapter),
  );

  if (initialWsPath) {
    try {
      await runtime.activate(initialWsPath);
    } catch (error) {
      console.error('LorraDriver init failed (will retry after workspace change):', error);
    }
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

// + T10 (session-reliability-multi-session):全池收口。
// D4 引入 driver 池后,退出必须 shutdown 全部池内 driver(后台会话随切保留),
// 不能只收口 active driver——否则后台 driver 的会话/定时器泄漏至进程退出。
app.on('before-quit', (event) => {
  if (!runtime) return;
  event.preventDefault();
  void runtime.disposeAll().finally(() => app.exit());
});
