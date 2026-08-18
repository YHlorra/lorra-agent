import { ArrowLeft } from 'lucide-react';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useAppStore } from '@/lib/app-store';
import { cn } from '@/lib/utils';
import type { ExperienceAuditDto, OkfCheckResultDto } from '../shared/memory-api';
import type { LorraError } from '../shared/result';
import type {
  BudgetStatus,
  CollectResult,
  SkillGitStatus,
  SkillInfo,
  SkillScope,
  SkillSource,
  SkillStats,
  SkillXray,
} from '../shared/skills-api';
import { SafeMarkdown } from './safe-markdown';

/**
 * 技能管理页(2026-08-12-skill-manager V1-11 + 2026-08-13 技能收集批, ):
 *
 * 页头(标题 + 副标题 + 返回工作台(embedded 嵌入插件页时隐藏);右侧操作:「收集散乱技能」
 * 「检查更新」(behind 计数 >0 时出现「更新 N 个」);「清理悬空」仅当
 * xray.dangling 非空时出现;安装已迁移为对话内 install_skill 工具,页头保留引导文案)
 * + 5 统计卡并排(repeat(5,1fr)):全部 / 45 天用过 / 吃灰(已启用 ∧ 本工作区启用
 * ∧ 未全局隐藏 ∧ recentCount=0,标签带窗口)/ 有问题 / 上下文预算第 5 卡
 * + 单表格(技能+徽章 / 位置徽章(scope 主文案「全局|项目」+ 来源副标签 +
 * title=完整路径)/ Git 徽章列(有更新/已修改)/ 45 天触发 / 最近触发 /
 * 本工作区开关(setWsEnabled,globallyHidden|systemManaged 禁用 + tooltip))
 * + 详情弹层:点行(开关/操作单元格除外)打开——描述(SafeMarkdown)/完整路径/
 * 健康项/统计块(45 天/总次数/最后触发/工作区分桶)/git 块/全局隐藏开关/编辑
 * + 编辑 = 仅工作区源技能(走现有 fs-ipc 打开链路)
 * + 三态:加载 / 错误(LorraError + 重试)/ 空态。
 *
 * 渲染纪律(design D10/S11):name/description 一律 React 文本或 SafeMarkdown,禁
 * dangerouslySetInnerHTML;description 不进表格列。
 * 动效:入场 stagger 28ms 封顶 340ms、≤300ms、只动
 * transform/opacity、prefers-reduced-motion 全局兜底(styles.css)、hover 包
 * (hover:hover) and (pointer:fine)、开关 130ms 无入场动画。
 */

export interface SkillsPageProps {
  /** 返回工作台(缺省走 app-store setPage('workspace'))。 */
  onBack?: () => void;
  /** 打开工作区文件到中栏(App 传 openFileFromTool,现有 fs-ipc 打开链路)。 */
  onOpenFile?: (target: string) => void;
  /** 嵌入插件页时隐藏页头返回钮(外层壳统一提供导航,2026-08-15)。 */
  embedded?: boolean;
}

/** 入场 stagger:28ms/块,上限 340ms(设计稿动效参数,对齐今日页)。 */
const ENTRANCE_STAGGER_MS = 28;
const ENTRANCE_STAGGER_MAX_MS = 340;

/** 位置徽章:scope 主文案(全局=处处触发 / 项目=仅该项目会话)。 */
const SCOPE_LABELS: Record<SkillScope, string> = {
  global: '全局',
  project: '项目',
};

/** 位置徽章副标签(source 映射)。 */
const SOURCE_SUB_LABELS: Record<SkillSource, string> = {
  collection: '收集库',
  workspace: '工作区',
  'lorra-global': 'lorra 库',
  user: '用户',
  ancestor: '祖先',
  'agent-plugin': '插件',
};

/** 健康徽章短文案(code → PM 语域;未知 code 直出 message)。 */
const ISSUE_LABELS: Record<string, string> = {
  'missing-description': '缺描述',
  'description-too-long': '描述过长',
  'missing-file': '文件缺失',
  'frontmatter-type-error': '元数据错误',
  'too-large': '文件过大',
};

/** 预算卡分级 cap 文案(design D14 定稿)。 */
const BUDGET_CAP: Record<BudgetStatus, string> = {
  good: '低于建议线 · 技能目录精简',
  warn: '接近上限 · 建议关闭低频技能或缩短描述',
  over: '超过参考线 · 建议关闭技能或缩短描述',
};

/** 相对时间/日期;从未触发 → null 给「从未使用」高行动信号。 */
function fmtLastUsed(ts: number | null): string {
  if (ts === null) return '从未使用';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function SkillsPage({ onBack, onOpenFile, embedded }: SkillsPageProps): JSX.Element {
  const setPage = useAppStore((s) => s.setPage);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<LorraError | null>(null);
  const [xray, setXray] = useState<SkillXray | null>(null);
  /** 行内动作错误(开关/收集/安装/更新失败),只影响本页。 */
  const [actionError, setActionError] = useState<LorraError | null>(null);
  const [cleaning, setCleaning] = useState(false);
  /** 正在写入开关的技能名(防重复提交;行内开关 + 弹层全局隐藏共用)。 */
  const [toggling, setToggling] = useState<ReadonlySet<string>>(new Set());
  /** 详情弹层选中技能(null = 关闭)。 */
  const [selected, setSelected] = useState<SkillInfo | null>(null);
  /** 收集结果提示条。 */
  const [collectResult, setCollectResult] = useState<CollectResult | null>(null);
  const [collecting, setCollecting] = useState(false);
  /** 检查更新结果(behind 计数 >0 → 「更新 N 个」按钮)。 */
  const [updateStatuses, setUpdateStatuses] = useState<Record<string, SkillGitStatus> | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  /** 统一更新结果提示条。 */
  const [updateResult, setUpdateResult] = useState<{ updated: string[]; skipped: string[] } | null>(
    null,
  );
  const [updatingAll, setUpdatingAll] = useState(false);
  const [experienceAudit, setExperienceAudit] = useState<ExperienceAuditDto | null>(null);
  const [okfAudit, setOkfAudit] = useState<OkfCheckResultDto | null>(null);

  const fetchXray = useCallback(async (): Promise<SkillXray> => {
    const bridge = window.lorra?.skills;
    if (!bridge) throw new Error('技能通道不可用');
    const res = await bridge.xray();
    if (!res.ok) throw res.error;
    return res.value;
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setPhase('loading');
    setActionError(null);
    try {
      setXray(await fetchXray());
      setError(null);
      setPhase('ready');
    } catch (cause) {
      setError(
        cause && typeof cause === 'object' && 'code' in cause
          ? (cause as LorraError)
          : {
              code: 'skills-load-failed',
              message: cause instanceof Error ? cause.message : String(cause),
            },
      );
      setPhase('error');
    }
  }, [fetchXray]);

  /** 静默重取(收集/更新/开关成功后刷新 xray,不闪 loading);返回新 xray(弹层同步用)。 */
  const refresh = useCallback(async (): Promise<SkillXray | null> => {
    try {
      const next = await fetchXray();
      setXray(next);
      setError(null);
      setPhase('ready');
      return next;
    } catch {
      // 静默失败:保留现有数据,不打断页面。
      return null;
    }
  }, [fetchXray]);

  const didMount = useRef(false);
  useEffect(() => {
    if (didMount.current) return;
    didMount.current = true;
    void load();
  }, [load]);

  const handleBack = useCallback(() => {
    if (onBack) onBack();
    else setPage('workspace');
  }, [onBack, setPage]);

  /** 行内开关 = 本工作区停用/启用(newmax 式):setWsEnabled IPC,成功后重拉 xray。 */
  const toggleWsEnabled = useCallback(
    async (skill: SkillInfo): Promise<void> => {
      if (!xray) return;
      // 开关开着 = 本工作区启用(on = !disabledInWs);点击 = 翻转 → next = !on。
      const on = !skill.disabledInWs;
      const next = !on;
      setActionError(null);
      setToggling((prev) => new Set(prev).add(skill.name));
      try {
        const res = await window.lorra.skills.setWsEnabled(skill.name, next, xray.workspacePath);
        if (!res.ok) {
          setActionError(res.error);
          return;
        }
        await refresh();
      } catch (cause) {
        setActionError({
          code: 'skills-toggle-failed',
          message: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        setToggling((prev) => {
          const nextSet = new Set(prev);
          nextSet.delete(skill.name);
          return nextSet;
        });
      }
    },
    [xray, refresh],
  );

  /** 弹层内全局隐藏开关:setEnabled IPC(全局隐藏名单),成功后重拉并同步弹层选中项。 */
  const toggleGlobalHide = useCallback(
    async (skill: SkillInfo): Promise<void> => {
      const next = !skill.globallyHidden;
      setActionError(null);
      setToggling((prev) => new Set(prev).add(skill.name));
      try {
        const res = await window.lorra.skills.setEnabled(skill.name, next);
        if (!res.ok) {
          setActionError(res.error);
          return;
        }
        const nextXray = await refresh();
        const updated = nextXray?.skills.find((s) => s.name === skill.name);
        if (updated) setSelected(updated);
      } catch (cause) {
        setActionError({
          code: 'skills-toggle-failed',
          message: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        setToggling((prev) => {
          const nextSet = new Set(prev);
          nextSet.delete(skill.name);
          return nextSet;
        });
      }
    },
    [refresh],
  );

  /** 清理悬空(当前工作区,与 xray 悬空清单同作用域);成功后静默重拉。 */
  const cleanDangling = useCallback(async (): Promise<void> => {
    if (!xray || xray.dangling.length === 0) return;
    setCleaning(true);
    setActionError(null);
    try {
      const res = await window.lorra.skills.cleanDangling(xray.workspacePath);
      if (!res.ok) {
        setActionError(res.error);
        return;
      }
      await refresh();
    } catch (cause) {
      setActionError({
        code: 'skills-clean-failed',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setCleaning(false);
    }
  }, [xray, refresh]);

  /** 收集散乱技能:collect IPC → 结果提示条 + 静默重拉。 */
  const handleCollect = useCallback(async (): Promise<void> => {
    if (!xray) return;
    setCollecting(true);
    setActionError(null);
    try {
      const res = await window.lorra.skills.collect(xray.workspacePath);
      if (!res.ok) {
        setActionError(res.error);
        return;
      }
      setCollectResult(res.value);
      await refresh();
    } catch (cause) {
      setActionError({
        code: 'skills-collect-failed',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setCollecting(false);
    }
  }, [xray, refresh]);

  /** 检查更新:网络 fetch 一次(checkUpdates 通道),behind 计数 >0 → 「更新 N 个」。 */
  const handleCheckUpdates = useCallback(async (): Promise<void> => {
    setCheckingUpdates(true);
    setActionError(null);
    try {
      const res = await window.lorra.skills.checkUpdates();
      if (!res.ok) {
        setActionError(res.error);
        return;
      }
      setUpdateStatuses(res.value);
    } catch (cause) {
      setActionError({
        code: 'skills-check-updates-failed',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setCheckingUpdates(false);
    }
  }, []);

  /** 统一更新:updateAll IPC → 结果提示条 + 静默重拉。 */
  const handleUpdateAll = useCallback(async (): Promise<void> => {
    setUpdatingAll(true);
    setActionError(null);
    try {
      const res = await window.lorra.skills.updateAll();
      if (!res.ok) {
        setActionError(res.error);
        return;
      }
      setUpdateResult(res.value);
      setUpdateStatuses(null);
      await refresh();
    } catch (cause) {
      setActionError({
        code: 'skills-update-failed',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setUpdatingAll(false);
    }
  }, [refresh]);

  /** 编辑:仅工作区源可点(现有 fs-ipc 打开链路),成功后切回工作台看中栏。 */
  const handleEdit = useCallback(
    (skill: SkillInfo): void => {
      if (!onOpenFile || skill.source !== 'workspace') return;
      setSelected(null);
      onOpenFile(skill.filePath);
      setPage('workspace');
    },
    [onOpenFile, setPage],
  );

  const skills = xray?.skills ?? [];
  const statsOf = useCallback((name: string): SkillStats | undefined => xray?.stats[name], [xray]);
  const gitOf = useCallback(
    (name: string): SkillGitStatus | undefined => xray?.gitStatus[name],
    [xray],
  );

  // 5 统计卡数字(口径 = spec「技能管理页」+ 2026-08-13 批):
  // 全部 = 列表长度;45 天用过 = recentCount>0;吃灰 = 已启用 ∧ 本工作区启用 ∧
  // 未全局隐藏 ∧ recentCount=0;有问题 = issues>0 且非系统管理;预算直接消费 xray.budget。
  const hero = useMemo(() => {
    const recentCount = (name: string): number => statsOf(name)?.recentCount ?? 0;
    return {
      total: skills.length,
      recent: skills.filter((s) => recentCount(s.name) > 0).length,
      idle: skills.filter(
        (s) => s.enabled && !s.disabledInWs && !s.globallyHidden && recentCount(s.name) === 0,
      ).length,
      issues: skills.filter((s) => !s.systemManaged && s.issues.length > 0).length,
    };
  }, [skills, statsOf]);

  // 默认最后触发倒序;从未使用(lastUsedAt=null)排后,同值按名称稳定。
  const rows = useMemo(() => {
    return [...skills].sort((a, b) => {
      const ta = statsOf(a.name)?.lastUsedAt ?? null;
      const tb = statsOf(b.name)?.lastUsedAt ?? null;
      if (ta !== null && tb !== null && ta !== tb) return tb - ta;
      if (ta === null && tb !== null) return 1;
      if (tb === null && ta !== null) return -1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
  }, [skills, statsOf]);

  const budget = xray?.budget;
  const fillPct = budget
    ? `${(Math.min(budget.estimatedTokens / budget.warnLine, 1) * 100).toFixed(1)}%`
    : '0%';

  // 检查更新结果:behind 计数(「更新 N 个」按钮出现条件)。
  const behindCount = useMemo(
    () => (updateStatuses ? Object.values(updateStatuses).filter((s) => s.behind).length : 0),
    [updateStatuses],
  );

  const selectedStats = selected ? statsOf(selected.name) : undefined;
  const selectedGit = selected ? gitOf(selected.name) : undefined;
  const selectedBuckets = useMemo(() => {
    if (!selectedStats) return [];
    return Object.entries(selectedStats.byWorkspace)
      .sort((a, b) => b[1] - a[1])
      .map(([ws, count]) => ({ ws, count }));
  }, [selectedStats]);

  useEffect(() => {
    let cancelled = false;
    async function loadAudit(): Promise<void> {
      if (!selected) {
        setExperienceAudit(null);
        setOkfAudit(null);
        return;
      }
      const memory = (
        window.lorra as typeof window.lorra & {
          memory?: {
            getExperienceAudit?: (
              nameOrId: string,
            ) => Promise<{ ok: boolean; value?: ExperienceAuditDto | null }>;
            okfCheck?: (path: string) => Promise<{ ok: boolean; value?: OkfCheckResultDto }>;
          };
        }
      ).memory;
      if (!memory) {
        setExperienceAudit(null);
        setOkfAudit(null);
        return;
      }
      const [experienceRes, okfRes] = await Promise.all([
        memory.getExperienceAudit
          ? memory.getExperienceAudit(selected.name)
          : Promise.resolve(null),
        memory.okfCheck ? memory.okfCheck(selected.filePath) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      setExperienceAudit(experienceRes && experienceRes.ok ? (experienceRes.value ?? null) : null);
      setOkfAudit(okfRes && okfRes.ok ? (okfRes.value ?? null) : null);
    }
    void loadAudit();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  return (
    <main className="skills-page" data-testid="skills-page">
      <header className="skills-head">
        {!embedded && (
          <button type="button" className="back-btn" aria-label="返回工作台" onClick={handleBack}>
            <ArrowLeft aria-hidden="true" />
          </button>
        )}
        <div className="head-title">
          <h1>技能管理</h1>
          {phase === 'ready' && hero.total > 0 && (
            <span className="skills-sub" data-testid="skills-subtitle">
              共 {hero.total} 个 · 45 天窗口
            </span>
          )}
        </div>
        {xray && (
          <div className="skills-head-actions">
            <button
              type="button"
              className="btn btn-ghost"
              data-testid="skills-collect"
              disabled={collecting}
              onClick={() => void handleCollect()}
            >
              收集散乱技能
            </button>
            <span className="skills-sub" data-testid="skills-install-hint">
              安装新技能：在对话里把技能仓库链接发给智能体
            </span>
            <button
              type="button"
              className="btn btn-ghost"
              data-testid="skills-check-updates"
              disabled={checkingUpdates}
              onClick={() => void handleCheckUpdates()}
            >
              检查更新
            </button>
            {behindCount > 0 && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                data-testid="skills-update-all"
                disabled={updatingAll}
                onClick={() => void handleUpdateAll()}
              >
                更新 {behindCount} 个
              </button>
            )}
            {xray.dangling.length > 0 && (
              <button
                type="button"
                className="btn btn-ghost skills-clean"
                data-testid="skills-clean-dangling"
                disabled={cleaning}
                onClick={() => void cleanDangling()}
              >
                清理悬空
              </button>
            )}
          </div>
        )}
      </header>

      <TooltipProvider delayDuration={300}>
        <div className="skills-scroll">
          {actionError && (
            <div className="skills-action-error" data-testid="skills-action-error" role="alert">
              {actionError.message}
            </div>
          )}

          {collectResult && (
            <div className="skills-result-banner" data-testid="skills-collect-result" role="status">
              <div className="sk-result-main">
                已收集 {collectResult.moved + collectResult.linked} 个：移动 {collectResult.moved} ·
                建链 {collectResult.linked}
              </div>
              {collectResult.conflicts.length > 0 && (
                <ul className="sk-result-list">
                  {collectResult.conflicts.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              )}
              {collectResult.notes.length > 0 && (
                <ul className="sk-result-list">
                  {collectResult.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {updateResult && (
            <div className="skills-result-banner" data-testid="skills-update-result" role="status">
              <div className="sk-result-main">
                更新成功 {updateResult.updated.length} 个，跳过 {updateResult.skipped.length} 个
              </div>
              {updateResult.skipped.length > 0 && (
                <ul className="sk-result-list">
                  {updateResult.skipped.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {phase === 'loading' && (
            <div className="skills-loading" data-testid="skills-loading" role="status">
              <div className="sk-hero" aria-hidden="true">
                {Array.from({ length: 5 }, (_, i) => (
                  <div className="sk-hc" key={i}>
                    <div className="sk-skeleton sk-skeleton-lb" />
                    <div className="sk-skeleton sk-skeleton-v" />
                    <div className="sk-skeleton sk-skeleton-cap" />
                  </div>
                ))}
              </div>
              <div className="sk-table" aria-hidden="true">
                {Array.from({ length: 5 }, (_, i) => (
                  <div className="sk-skeltable-row" key={i}>
                    <span className="sk-skeleton sk-skel-name" />
                    <span className="sk-skeleton sk-skel-pos" />
                    <span className="sk-skeleton sk-skel-num" />
                    <span className="sk-skeleton sk-skel-num" />
                    <span className="sk-skeleton sk-skel-tg" />
                  </div>
                ))}
              </div>
            </div>
          )}

          {phase === 'error' && (
            <div className="skills-error" data-testid="skills-error" role="alert">
              <div className="skills-error-msg">
                {error?.message ?? '无法读取技能,请稍后重试。'}
              </div>
              <button type="button" className="btn btn-primary" onClick={() => void load()}>
                重试
              </button>
            </div>
          )}

          {phase === 'ready' && xray && hero.total === 0 && (
            <div className="skills-empty" data-testid="skills-empty">
              <div className="e-title">还没有技能</div>
              <div className="e-sub">
                <div>
                  技能位于工作区 .lorra/skills、收集库或全局技能库，安装后会自动出现在这里。
                </div>
                <div className="skills-empty-hint">
                  行内开关控制该技能是否在本工作区注入提示清单。
                </div>
              </div>
            </div>
          )}

          {phase === 'ready' && xray && hero.total > 0 && (
            <>
              {/* 5 统计卡并排(repeat(5,1fr));第 5 卡 = 上下文预算(design D14)。 */}
              <section className="sk-hero" aria-label="技能概览">
                <div className="sk-hc sk-anim" data-testid="skills-hero-card" data-metric="total">
                  <div className="sk-hc-lb">全部技能</div>
                  <div className="sk-hc-v">{hero.total}</div>
                  <div className="sk-hc-cap">已安装并注册</div>
                </div>
                <div
                  className="sk-hc sk-anim"
                  data-testid="skills-hero-card"
                  data-metric="recent"
                  style={{ animationDelay: '28ms' }}
                >
                  <div className="sk-hc-lb">45 天用过</div>
                  <div className="sk-hc-v">{hero.recent}</div>
                  <div className="sk-hc-cap">至少触发过一次</div>
                </div>
                <div
                  className="sk-hc sk-anim"
                  data-testid="skills-hero-card"
                  data-metric="idle"
                  style={{ animationDelay: '56ms' }}
                >
                  <div className="sk-hc-lb">吃灰</div>
                  <div className="sk-hc-v">{hero.idle}</div>
                  <div className="sk-hc-cap">45 天未触发</div>
                </div>
                <div
                  className="sk-hc sk-anim"
                  data-testid="skills-hero-card"
                  data-metric="issues"
                  style={{ animationDelay: '84ms' }}
                >
                  <div className="sk-hc-lb">有问题</div>
                  <div className={cn('sk-hc-v', 'danger')}>{hero.issues}</div>
                  <div className="sk-hc-cap">缺描述 · 描述过长</div>
                </div>
                {budget && (
                  <div
                    className="sk-hc sk-anim"
                    data-testid="skills-hero-card"
                    data-metric="budget"
                    style={{ animationDelay: '112ms' }}
                  >
                    <div className="sk-hc-lb">上下文预算</div>
                    <div
                      className="sk-hc-v"
                      data-testid="skills-budget-value"
                      title="token 估算 = Σ 启用技能描述字符数 ÷3.5"
                    >
                      {budget.estimatedTokens.toLocaleString('zh-CN')}
                    </div>
                    {/* mini 条:0–4,000 tokens 满刻;2,000 淡次刻度 50% + 4,000 主刻度 100% 右对齐 */}
                    <div className="sk-budget-mini" aria-hidden="true">
                      <i
                        className={cn('sk-budget-fill', `budget-${budget.status}`)}
                        data-testid="skills-budget-fill"
                        data-status={budget.status}
                        style={{ width: fillPct }}
                      />
                      <span
                        className="sk-budget-tick sk-budget-tick-good"
                        data-testid="skills-budget-tick"
                        data-token="2000"
                        style={{ left: '50%' }}
                      />
                      <span
                        className="sk-budget-tick"
                        data-testid="skills-budget-tick"
                        data-token="4000"
                        style={{ left: '100%' }}
                      />
                      <span className="sk-budget-ticklabel" style={{ left: '50%' }}>
                        2,000
                      </span>
                      <span className="sk-budget-ticklabel main" style={{ left: '100%' }}>
                        4,000
                      </span>
                    </div>
                    <div className="sk-hc-cap" data-testid="skills-budget-cap">
                      {BUDGET_CAP[budget.status]}
                    </div>
                  </div>
                )}
              </section>

              {/* 单表格:技能+徽章 / 位置(scope) / Git / 45 天 / 最近触发 / 本工作区开关 / 操作 */}
              <table className="sk-table" data-testid="skills-table">
                <thead>
                  <tr>
                    <th>技能</th>
                    <th>位置</th>
                    <th>Git</th>
                    <th className="c">45 天</th>
                    <th>最近触发</th>
                    <th>状态</th>
                    <th className="c">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((skill, i) => {
                    const st = statsOf(skill.name);
                    const git = gitOf(skill.name);
                    const never = (st?.totalCount ?? 0) === 0;
                    const delay = Math.min((i + 1) * ENTRANCE_STAGGER_MS, ENTRANCE_STAGGER_MAX_MS);
                    const editable = skill.source === 'workspace';
                    const on = !skill.disabledInWs;
                    const toggleDisabled =
                      skill.systemManaged || skill.globallyHidden || toggling.has(skill.name);
                    const toggleTitle = skill.systemManaged
                      ? '由系统管理'
                      : skill.globallyHidden
                        ? '已全局隐藏'
                        : undefined;
                    const toggle = (
                      // biome-ignore lint/a11y/useKeyWithClickEvents: 纯 stopPropagation 容器,键盘语义由内部 checkbox 承担
                      <label
                        className={cn('sk-tg', on && 'on', toggleDisabled && 'disabled')}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          data-testid="skills-toggle"
                          data-name={skill.name}
                          aria-label={`${on ? '停用' : '启用'} ${skill.name}（本工作区）`}
                          checked={on}
                          disabled={toggleDisabled}
                          onChange={() => void toggleWsEnabled(skill)}
                          title={toggleTitle}
                        />
                        <span className="sk-tg-track" aria-hidden="true" />
                      </label>
                    );
                    const editBtn = (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm sk-edit"
                        data-testid="skills-edit"
                        data-name={skill.name}
                        disabled={!editable}
                        title={editable ? undefined : '仅工作区技能可编辑'}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEdit(skill);
                        }}
                      >
                        编辑
                      </button>
                    );
                    return (
                      <tr
                        className="sk-anim sk-row-clickable"
                        key={skill.name}
                        data-testid="skills-row"
                        data-name={skill.name}
                        style={{ animationDelay: `${delay}ms` }}
                        onClick={() => setSelected(skill)}
                      >
                        <td>
                          <span className="sk-skill-name">
                            {skill.name}
                            {skill.systemManaged && (
                              <span className="sk-b sk-b-inner">内部·未注入</span>
                            )}
                            {skill.isDuplicate && <span className="sk-b sk-b-dupe">副本</span>}
                            {!skill.systemManaged &&
                              skill.issues.map((issue) => (
                                <span
                                  className="sk-b sk-b-issue"
                                  key={issue.code}
                                  title={issue.message}
                                >
                                  {ISSUE_LABELS[issue.code] ?? issue.message}
                                </span>
                              ))}
                          </span>
                        </td>
                        <td>
                          <span className="sk-pos" data-scope={skill.scope} title={skill.filePath}>
                            {SCOPE_LABELS[skill.scope]}
                            <span className="sk-pos-sub">{SOURCE_SUB_LABELS[skill.source]}</span>
                          </span>
                        </td>
                        <td className="c">
                          {git?.behind && (
                            <span
                              className="sk-b sk-b-git-behind"
                              data-testid="skills-git-badge"
                              data-state="behind"
                            >
                              有更新
                            </span>
                          )}
                          {git?.dirty && (
                            <span
                              className="sk-b sk-b-git-dirty"
                              data-testid="skills-git-badge"
                              data-state="dirty"
                            >
                              已修改
                            </span>
                          )}
                        </td>
                        <td className="c">
                          <span
                            className={cn('sk-count', never && 'never')}
                            title={`累计 ${st?.totalCount ?? 0} 次`}
                          >
                            {st?.recentCount ?? 0}
                          </span>
                        </td>
                        <td>
                          <span className={cn('sk-last', never && 'never')}>
                            {fmtLastUsed(st?.lastUsedAt ?? null)}
                          </span>
                        </td>
                        {/* biome-ignore lint/a11y/useKeyWithClickEvents: 纯 stopPropagation 容器(开关/按钮自有键盘语义) */}
                        <td onClick={(e) => e.stopPropagation()}>
                          <span className="sk-tgrow">
                            {toggleDisabled ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="sk-tt-wrap">{toggle}</span>
                                </TooltipTrigger>
                                <TooltipContent side="left">
                                  {skill.systemManaged ? '由系统管理' : '已全局隐藏'}
                                </TooltipContent>
                              </Tooltip>
                            ) : (
                              toggle
                            )}
                          </span>
                        </td>
                        {/* biome-ignore lint/a11y/useKeyWithClickEvents: 纯 stopPropagation 容器(编辑按钮自有键盘语义) */}
                        <td onClick={(e) => e.stopPropagation()}>
                          <span className="sk-tgrow">
                            {editable ? (
                              editBtn
                            ) : (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="sk-tt-wrap">{editBtn}</span>
                                </TooltipTrigger>
                                <TooltipContent side="left">仅工作区技能可编辑</TooltipContent>
                              </Tooltip>
                            )}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="sk-frow" data-testid="skills-frow">
                    <td colSpan={7}>共 {hero.total} 个 · 全量技能按最近触发排序</td>
                  </tr>
                </tfoot>
              </table>
            </>
          )}
        </div>
      </TooltipProvider>

      {/* 详情弹层:点行打开(开关/操作单元格 stopPropagation);X/遮罩关闭。 */}
      {selected && (
        <Dialog open onOpenChange={(open) => setSelected(open ? selected : null)}>
          <DialogContent
            className="skills-detail"
            data-testid="skills-detail-modal"
            aria-label={`${selected.name} 详情`}
          >
            <div className="sk-detail-head">
              <h2 className="sk-detail-name">{selected.name}</h2>
              <span className="sk-b sk-b-scope" data-scope={selected.scope}>
                {SCOPE_LABELS[selected.scope]}
              </span>
              <span className="sk-b sk-b-src">{SOURCE_SUB_LABELS[selected.source]}</span>
            </div>
            <div
              className="sk-detail-path"
              data-testid="skills-detail-path"
              title={selected.filePath}
            >
              {selected.filePath}
            </div>
            {selected.description ? (
              <div className="sk-detail-desc" data-testid="skills-detail-desc">
                <SafeMarkdown content={selected.description} />
              </div>
            ) : (
              <div className="sk-detail-muted" data-testid="skills-detail-desc">
                缺描述（技能不会被注入提示清单）
              </div>
            )}
            {selected.issues.length > 0 && (
              <ul className="sk-detail-issues" data-testid="skills-detail-issues">
                {selected.issues.map((issue) => (
                  <li className="sk-b sk-b-issue" key={issue.code}>
                    {issue.message}
                  </li>
                ))}
              </ul>
            )}
            {(experienceAudit || okfAudit) && (
              <div className="sk-detail-provenance" data-testid="skills-detail-provenance">
                {experienceAudit && (
                  <>
                    <div>
                      {experienceAudit.generated ? 'generated skill' : '普通 skill'}；case:
                      {experienceAudit.caseIds.join(', ') || '无'}；entry:
                      {experienceAudit.entryIds.join(', ') || '无'}
                    </div>
                    {experienceAudit.warnings.length > 0 && (
                      <div>警告：{experienceAudit.warnings.join('；')}</div>
                    )}
                  </>
                )}
                {okfAudit && (
                  <div data-testid="skills-detail-okf">
                    OKF：type={okfAudit.type ?? 'unknown'}；verified=
                    {okfAudit.verified ? 'true' : 'false'}；问题 {okfAudit.issues.length} 项
                    {okfAudit.issues.length > 0 ? `；${okfAudit.issues[0]?.message ?? ''}` : ''}
                  </div>
                )}
              </div>
            )}
            <div className="sk-detail-stats" data-testid="skills-detail-stats">
              <div className="sk-detail-stat">
                <span className="sk-detail-stat-lb">45 天触发</span>
                <span className="sk-detail-stat-v num">{selectedStats?.recentCount ?? 0}</span>
              </div>
              <div className="sk-detail-stat">
                <span className="sk-detail-stat-lb">总次数</span>
                <span className="sk-detail-stat-v num">{selectedStats?.totalCount ?? 0}</span>
              </div>
              <div className="sk-detail-stat">
                <span className="sk-detail-stat-lb">最后触发</span>
                <span className="sk-detail-stat-v">
                  {fmtLastUsed(selectedStats?.lastUsedAt ?? null)}
                </span>
              </div>
              {selectedBuckets.length > 0 && (
                <div className="sk-detail-buckets">
                  {selectedBuckets.map(({ ws, count }) => (
                    <div className="sk-detail-bucket" key={ws} title={ws}>
                      <span className="sk-detail-bucket-ws">{pathLabel(ws)}</span>
                      <span className="sk-detail-bucket-n num">{count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {selectedGit && (
              <div className="sk-detail-git" data-testid="skills-detail-git">
                <div className="sk-detail-git-url" title={selectedGit.gitUrl}>
                  {selectedGit.gitUrl}
                </div>
                {selectedGit.behind && (
                  <span className="sk-b sk-b-git-behind" data-state="behind">
                    有更新
                  </span>
                )}
                {selectedGit.dirty && (
                  <span className="sk-b sk-b-git-dirty" data-state="dirty">
                    已修改
                  </span>
                )}
              </div>
            )}
            <div className="sk-detail-actions">
              <label
                className={cn(
                  'sk-tg',
                  selected.globallyHidden && 'on',
                  (selected.systemManaged || toggling.has(selected.name)) && 'disabled',
                )}
              >
                <input
                  type="checkbox"
                  data-testid="skills-detail-hide"
                  aria-label={`${selected.globallyHidden ? '取消' : ''}全局隐藏 ${selected.name}`}
                  checked={selected.globallyHidden}
                  disabled={selected.systemManaged || toggling.has(selected.name)}
                  onChange={() => void toggleGlobalHide(selected)}
                />
                <span className="sk-tg-track" aria-hidden="true" />
              </label>
              <span className="sk-detail-hide-label">全局隐藏</span>
              <span className="sk-detail-spacer" />
              <button
                type="button"
                className="btn btn-ghost btn-sm sk-edit"
                data-testid="skills-detail-edit"
                disabled={selected.source !== 'workspace'}
                title={selected.source === 'workspace' ? undefined : '仅工作区技能可编辑'}
                onClick={() => handleEdit(selected)}
              >
                编辑
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </main>
  );
}

/** 工作区分桶展示名:取路径末段,title 带完整路径。 */
function pathLabel(ws: string): string {
  const base = ws.replace(/[\\/]+$/, '');
  const idx = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
  return idx >= 0 ? base.slice(idx + 1) : base;
}
