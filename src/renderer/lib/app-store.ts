import { create } from 'zustand';
import type { Lang } from '../../shared/i18n-core';
import type { Theme } from './theme';
import { readUiPrefs, writeUiPrefs } from './theme';

// 页面路由(design.md .1):最左图标栏切换工作台/今日/记忆/模型配置/技能/设置。
export type AppPage = 'workspace' | 'today' | 'memory' | 'providers' | 'skills' | 'settings';

interface AppStoreState {
  page: AppPage;
  setPage: (page: AppPage) => void;
  // 主题与图标栏折叠:state 只存当前值,持久化走 lorra-ui(localStorage)。
  theme: Theme;
  setTheme: (theme: Theme) => void;
  navCollapsed: boolean;
  toggleNav: () => void;
  // 界面语言:首帧取 localStorage 缓存,App 挂载后用 settings.json 真源校正。
  language: Lang;
  /** 用户切换:本地立即生效 + 写缓存 + 回写 settings.json(IPC 失败不阻断)。 */
  setLanguage: (lang: Lang) => void;
  /** 真源校正:仅本地 + 写缓存,不触发 IPC 回写(避免启动时倒灌)。 */
  applyLanguage: (lang: Lang) => void;
  // 文件树隐藏项:从 App 局部 state 提升,设置页与工作台共享同一状态。
  showHiddenFiles: boolean;
  setShowHiddenFiles: (next: boolean) => void;
  // 思考链默认折叠(设置页「默认隐藏思考链」):settings.json 持久化,思考卡创建时读。
  defaultHideThinking: boolean;
  setDefaultHideThinking: (next: boolean) => void;
  // 语义清洗模型:null = 跟随默认;设置页「语义清洗模型」选择器读写。
  compileModel: { providerId: string; modelId: string } | null;
  setCompileModel: (next: { providerId: string; modelId: string } | null) => void;
  // 数据源开关:内置适配器启用;设置页「数据源」组读写。
  dataSources: { claudeCode: boolean; opencode: boolean; ohMyPi: boolean; workbuddy: boolean };
  setDataSource: (
    runtime: 'claudeCode' | 'opencode' | 'ohMyPi' | 'workbuddy',
    enabled: boolean,
  ) => void;
  /** 数据源开关水合:启动/设置页打开时从 settings.json 读真源,
 * 只改 store 不触发 IPC 写回(与 setDataSource 的写路径分离)。 */
  hydrateDataSources: (next: {
    claudeCode: boolean;
    opencode: boolean;
    ohMyPi: boolean;
    workbuddy: boolean;
  }) => void;
}

// 模块加载时读一次(localStorage + 系统偏好兜底),供 initTheme 首帧使用。
const initial = readUiPrefs();

export const useAppStore = create<AppStoreState>()((set, get) => ({
  page: 'workspace',
  setPage: (page) => set({ page }),
  theme: initial.theme,
  setTheme: (theme) => {
    writeUiPrefs({ ...get(), theme });
    set({ theme });
  },
  navCollapsed: initial.navCollapsed,
  toggleNav: () => {
    const navCollapsed = !get().navCollapsed;
    writeUiPrefs({ ...get(), navCollapsed });
    set({ navCollapsed });
  },
  language: initial.language,
  setLanguage: (lang) => {
    writeUiPrefs({ ...get(), language: lang });
    void window.lorra.settings.set({ language: lang }).catch(() => {});
    set({ language: lang });
  },
  applyLanguage: (lang) => {
    writeUiPrefs({ ...get(), language: lang });
    set({ language: lang });
  },
  showHiddenFiles: false,
  setShowHiddenFiles: (next) => {
    void window.lorra.settings.set({ showHiddenFiles: next }).catch(() => {});
    set({ showHiddenFiles: next });
  },
  defaultHideThinking: false,
  setDefaultHideThinking: (next) => {
    void window.lorra.settings.set({ defaultHideThinking: next }).catch(() => {});
    set({ defaultHideThinking: next });
  },
  compileModel: null,
  setCompileModel: (next) => {
    void window.lorra.settings.set({ compileModel: next }).catch(() => {});
    set({ compileModel: next });
  },
  dataSources: { claudeCode: false, opencode: false, ohMyPi: false, workbuddy: false },
  setDataSource: (runtime, enabled) => {
    void window.lorra.settings.set({ dataSources: { [runtime]: enabled } }).catch(() => {});
    set((state) => ({ dataSources: { ...state.dataSources, [runtime]: enabled } }));
  },
  hydrateDataSources: (next) => set({ dataSources: { ...next } }),
}));
