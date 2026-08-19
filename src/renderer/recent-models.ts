/**
 * 最近使用的模型(最多 3 个):localStorage,本机持久、重启不丢。
 * 与主进程无关(不写 SettingsManager),纯渲染端增强切换体验。
 */
const RECENT_KEY = 'lorra:recentModels';
const RECENT_LIMIT = 3;

export interface RecentModel {
  providerId: string;
  modelId: string;
}

export function readRecentModels(): RecentModel[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is RecentModel =>
        !!x &&
        typeof (x as RecentModel).providerId === 'string' &&
        typeof (x as RecentModel).modelId === 'string',
    );
  } catch {
    return [];
  }
}

/** 置顶去重,只留最近 RECENT_LIMIT 个。存储不可用(隐私模式/配额)时静默退化为不记录。 */
export function pushRecentModel(entry: RecentModel): void {
  const rest = readRecentModels().filter(
    (m) => !(m.providerId === entry.providerId && m.modelId === entry.modelId),
  );
  const next = [entry, ...rest].slice(0, RECENT_LIMIT);
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // 静默:最近使用退化,不影响切换功能。
  }
}
