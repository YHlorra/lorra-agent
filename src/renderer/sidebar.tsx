import { Search, SquarePen } from 'lucide-react';
import type { JSX } from 'react';
import { memo } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { FileTree } from './file-tree';
import { useT } from './lib/i18n';

const WORKSPACE_ROOT_ID = 'ws-root';

interface SidebarProps {
  activeSessionId: string | null;
  sessionHistory: LorraSessionInfo[];
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
}

// 侧栏(design.md .1):文件树 + 会话管理统一区,Obsidian 式上下分区。
// 组件化(2026-08-07):logo 区 + 快捷操作 + 会话/文件分组 + 底部工作区条。
// memo(2026-08-13 性能):流式事件驱动 App 整树重渲染,props 未变时跳过。
export const Sidebar = memo(function Sidebar(props: SidebarProps): JSX.Element {
  const t = useT();
  const activeSummary = props.sessionHistory.find((s) => s.id === props.activeSessionId);

  return (
    // left-pane 仅作窄屏响应式隐藏钩子(styles.css @media)。
    <aside
      className="left-pane flex h-full min-h-0 flex-col border-r border-line bg-paper-mid"
      aria-label={t('sidebar.navLabel')}
    >
      {/* logo 区:品牌标记 + 产品名(参考布局顶栏 logo 位)。 */}
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-3.5">
        <span className="sidebar-logo" aria-hidden="true">
          L
        </span>
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
          <nav aria-label={t('sidebar.sessionList')} className="flex flex-col gap-0.5">
            {props.activeSessionId && (
              <button className={navRow(true)} type="button">
                <span className="w-full truncate text-[13px]">
                  {activeSummary?.firstMessage || t('sidebar.currentSession')}
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
              .map((session) => (
                <button
                  key={session.id}
                  className={navRow(false)}
                  type="button"
                  onClick={() => props.onOpenSession(session.id)}
                >
                  <span className="w-full truncate text-[13px]">
                    {session.firstMessage || session.name || session.id}
                  </span>
                  <time className="text-[10px] text-ink-muted">
                    {t('sidebar.messageCount', { count: session.messageCount })}
                  </time>
                </button>
              ))}
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
    'flex w-full flex-col items-start gap-0.5 rounded-kami px-2.5 py-2 text-left transition-colors hover:bg-paper/70',
    active && 'bg-overlay',
  );
}
