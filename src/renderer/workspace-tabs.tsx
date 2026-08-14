import { Plus } from 'lucide-react';
import type { JSX } from 'react';
import { cn } from '@/lib/utils';
import { useT } from './lib/i18n';

export interface WorkspaceTabsProps {
  /** 最近工作区列表(首项为当前激活)。 */
  workspaces: string[];
  /** 当前激活工作区路径。 */
  activePath: string | null;
  /** 点击 tab:按路径激活(主进程 recordRecent + 重建 driver)。 */
  onActivate: (path: string) => void;
  /** 点击 +:打开目录选择框新建/切换工作区。 */
  onAdd: () => void;
}

/** 路径 → 展示名:取 basename,空则回退完整路径。 */
function workspaceLabel(path: string): string {
  const base = path.split(/[\\/]/).filter(Boolean).pop();
  return base || path;
}

/**
 * 工作区 tab 条(顶栏):最近工作区并排,当前激活整块底色高亮(P-38 禁左侧竖线)。
 * 参考布局:AgentTrend / 默认工作区 + 「+」。点击 tab 走 activate(按路径,
 * 不弹选择框);「+」走目录选择。
 */
export function WorkspaceTabs({
  workspaces,
  activePath,
  onActivate,
  onAdd,
}: WorkspaceTabsProps): JSX.Element {
  const t = useT();
  return (
    <div className="workspace-tabs" role="tablist" aria-label={t('workspaceTabs.label')}>
      {workspaces.map((path) => {
        const active = path === activePath;
        return (
          <button
            key={path}
            type="button"
            role="tab"
            aria-selected={active}
            title={path}
            onClick={() => onActivate(path)}
            className={cn('workspace-tab', active && 'workspace-tab-active')}
          >
            <span className="workspace-tab-mark" aria-hidden="true">
              {workspaceLabel(path).charAt(0).toUpperCase()}
            </span>
            <span className="workspace-tab-label">{workspaceLabel(path)}</span>
          </button>
        );
      })}
      <button
        type="button"
        className="workspace-tab-add"
        aria-label={t('workspaceTabs.add')}
        onClick={onAdd}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
