import { Search, SquarePen } from 'lucide-react';
import type { JSX } from 'react';
import { memo } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { FileTree } from './file-tree';
import { useT } from './lib/i18n';
import type { SessionIndicator } from './reducer';

const WORKSPACE_ROOT_ID = 'ws-root';

/** 指示灯态 → i18n 词条(aria/tooltip 文案)。 */
const INDICATOR_LABEL_KEY = {
  running: 'sidebar.indicator.running',
  idle: 'sidebar.indicator.idle',
  stuck: 'sidebar.indicator.stuck',
  'never-run': 'sidebar.indicator.neverRun',
} as const;

/** 会话状态指示灯(红=卡住,黄=空闲,绿=运行中,灰=未运行)。 */
function SessionIndicatorDot({
  state,
  label,
}: {
  state: SessionIndicator;
  label: string;
}): JSX.Element {
  return (
    <span
      className="session-indicator"
      data-state={state}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}

interface SidebarProps {
  activeSessionId: string | null;
  sessionHistory: LorraSessionInfo[];
  /** 会话状态指示灯(sessionId → 态):绿=运行中,黄=空闲,红=卡住,灰=未运行。 */
  sessionIndicators: Record<string, SessionIndicator>;
  sessionBootstrapping: boolean;
  activeFileId: string | null;
  showHiddenFiles?: boolean;
  onToggleHidden?: () => void;
  onCreateSession: () => void;
  onOpenSession: (sessionId: string) => void;
  onSelectFile: (fileId: string, name: string) => void;
  /** 打开命令面板(搜索/恢复会话)。 */
  onOpenPalette?: () => void;
  /** 切换工作区(底部工作区条)。 */
  onSwitchWorkspace?: () => void;
  /**
   * 当前工作区路径:作 FileTree 的 key,切换工作区时重挂载文件树,
   * 重新拉取新工作区内容(会话列表已按工作区刷新,文件树靠它同步)。
   */
  workspaceKey?: string;
}

// 侧栏(design.md .1):文件树 + 会话管理统一区,Obsidian 式上下分区。
// 组件化(2026-08-07):logo 区 + 快捷操作 + 会话/文件分组 + 底部工作区条。
// memo(2026-08-13 性能):流式事件驱动 App 整树重渲染,props 未变时跳过。
export const Sidebar = memo(function Sidebar(props: SidebarProps): JSX.Element {
  const t = useT();
  const activeSummary = props.sessionHistory.find((s) => s.id === props.activeSessionId);
  const activeIndicator: SessionIndicator = props.activeSessionId
    ? (props.sessionIndicators[props.activeSessionId] ?? 'never-run')
    : 'never-run';

  return (
    // left-pane 仅作窄屏响应式隐藏钩子(styles.css @media)。
    <aside
      className="left-pane flex h-full min-h-0 flex-col border-r border-line bg-paper-mid"
      aria-label={t('sidebar.navLabel')}
    >
      {/* logo 区:品牌标记 + 产品名(参考布局顶栏 logo 位)。 */}
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-3.5">
        <span className="sidebar-logo" aria-hidden="true" />
        <div className="min-w-0">
          <p className="sidebar-brand m-0">lorra</p>
          <p className="sidebar-tagline m-0">{t('sidebar.tagline')}</p>
        </div>
      </div>

      {/* 快捷操作:新建对话 / 搜索(命令面板)。 */}
      <div className="flex shrink-0 gap-1.5 px-2.5 pt-2.5">
        <button
          type="button"
          className="sidebar-quick sidebar-quick-primary"
          onClick={props.onCreateSession}
        >
          <SquarePen className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{t('sidebar.newChat')}</span>
        </button>
        <button
          type="button"
          className="sidebar-quick"
          aria-label={t('sidebar.search')}
          title={t('sidebar.searchHint')}
          onClick={props.onOpenPalette}
        >
          <Search className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      <section
        className="flex min-h-0 flex-1 flex-col border-b border-line"
        aria-label={t('sidebar.sessionSection')}
      >
        <div className="flex h-9 shrink-0 items-center justify-between pr-2 pl-3.5">
          <h2 className="m-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
            {t('sidebar.sessions')}
          </h2>
          <button
            type="button"
            aria-label={t('sidebar.newSession')}
            onClick={props.onCreateSession}
            className="flex h-8 w-8 items-center justify-center rounded-kami text-ink-secondary transition-colors hover:bg-paper hover:text-navy"
          >
            ＋
          </button>
        </div>
        <ScrollArea className="min-h-0 flex-1 px-2 pb-2.5">
          {/* min-w-0:长无断行文本(会话标题/文件名)会撑爆 flex 项 min-width,溢出到中栏拦截点击
 (PROB 会话栏无法切换根因)。min-w-0 让按钮可收缩到侧栏宽,span truncate 负责省略号。 */}
          <nav aria-label={t('sidebar.sessionList')} className="flex min-w-0 flex-col gap-0.5">
            {props.activeSessionId && (
              <button className={navRow(true)} type="button">
                <span className="flex w-full min-w-0 items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    {activeSummary?.firstMessage || t('sidebar.currentSession')}
                  </span>
                  <SessionIndicatorDot
                    state={activeIndicator}
                    label={t(INDICATOR_LABEL_KEY[activeIndicator])}
                  />
                </span>
                <time className="text-[10px] text-ink-muted">
                  {activeSummary
                    ? t('sidebar.messageCount', { count: activeSummary.messageCount })
                    : props.activeSessionId.slice(0, 8)}
                </time>
              </button>
            )}
            {props.sessionHistory
              .filter((session) => session.id !== props.activeSessionId)
              .map((session) => {
                const indicator: SessionIndicator =
                  props.sessionIndicators[session.id] ?? 'never-run';
                return (
                  <button
                    key={session.id}
                    className={navRow(false)}
                    type="button"
                    onClick={() => props.onOpenSession(session.id)}
                  >
                    <span className="flex w-full min-w-0 items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-[13px]">
                        {session.firstMessage || session.name || session.id}
                      </span>
                      <SessionIndicatorDot
                        state={indicator}
                        label={t(INDICATOR_LABEL_KEY[indicator])}
                      />
                    </span>
                    <time className="text-[10px] text-ink-muted">
                      {t('sidebar.messageCount', { count: session.messageCount })}
                    </time>
                  </button>
                );
              })}
            {!props.activeSessionId && props.sessionBootstrapping && (
              <p className="px-2.5 py-1 text-xs text-ink-tertiary">
                {t('sidebar.loadingSessions')}
              </p>
            )}
            {!props.activeSessionId &&
              !props.sessionBootstrapping &&
              props.sessionHistory.length === 0 && (
                <p className="px-2.5 py-1 text-xs text-ink-tertiary">{t('sidebar.noSessions')}</p>
              )}
          </nav>
        </ScrollArea>
      </section>

      <section className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center justify-between pr-2 pl-3.5">
          <h2 className="m-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
            {t('sidebar.files')}
          </h2>
          <button
            type="button"
            aria-label={t('sidebar.refreshTree')}
            className="flex h-8 w-8 items-center justify-center rounded-kami text-ink-secondary transition-colors hover:bg-paper hover:text-navy"
          >
            ↻
          </button>
        </div>
        <ScrollArea className="min-h-0 flex-1 px-2 pb-2.5">
          <FileTree
            key={props.workspaceKey ?? WORKSPACE_ROOT_ID}
            rootId={WORKSPACE_ROOT_ID}
            selectedFileId={props.activeFileId}
            onSelect={props.onSelectFile}
            showHiddenFiles={props.showHiddenFiles}
            onToggleHidden={props.onToggleHidden}
          />
        </ScrollArea>
      </section>

      {/* 底部工作区条(参考布局用户区):当前工作区 + 切换入口。 */}
      {props.onSwitchWorkspace ? (
        <div className="sidebar-footer">
          <button
            type="button"
            className="sidebar-workspace"
            onClick={props.onSwitchWorkspace}
            title={t('sidebar.switchWorkspace')}
          >
            <span className="sidebar-workspace-mark" aria-hidden="true">
              W
            </span>
            <span className="sidebar-workspace-label">{t('sidebar.switchWorkspace')}</span>
          </button>
        </div>
      ) : null}
    </aside>
  );
});

function navRow(active: boolean): string {
  return cn(
    'flex w-full min-w-0 flex-col items-start gap-0.5 rounded-kami px-2.5 py-2 text-left transition-colors hover:bg-paper/70',
    active && 'bg-overlay',
  );
}
