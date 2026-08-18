import { Plus, X } from 'lucide-react';
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
  /**
   * 点击 tab 上的「×」:从最近工作区列表移除(lorra.workspace.remove)。
   * 仅减少界面视觉负担:工作区数据保留在后台,用户可随时重新添加。
   * 激活中的工作区不渲染移除按钮(与设置页一致,保持 recentWorkspaces[0]=激活 不变量)。
   */
  onRemove: (path: string) => void;
}

/** 路径 → 展示名:取 basename,空则回退完整路径。 */
function workspaceLabel(path: string): string {
  const base = path.split(/[\\/]/).filter(Boolean).pop();
  return base || path;
}

/**
 * 工作区 tab 条(顶栏):最近工作区并排,当前激活整块底色高亮(P-38 禁左侧竖线)。
 * 参考布局:AgentTrend / 默认工作区 + 「+」。点击 tab 走 activate(按路径,
 * 不弹选择框);「+」走目录选择;非激活 tab 悬停出现「×」= 从列表移除(仅 UI,
 * 数据保留,2026-08-18)。外层 div 承担胶囊外观,内部拆「激活按钮 + 移除按钮」,
 * 避免 button 嵌套(HTML 非法)。
 */
export function WorkspaceTabs({
  workspaces,
  activePath,
  onActivate,
  onAdd,
  onRemove,
}: WorkspaceTabsProps): JSX.Element {
  const t = useT();
  return (
    <div className="workspace-tabs" role="tablist" aria-label={t('workspaceTabs.label')}>
      {workspaces.map((path) => {
        const active = path === activePath;
        const label = workspaceLabel(path);
        return (
          <div
            key={path}
            className={cn('workspace-tab', active && 'workspace-tab-active')}
            title={path}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="workspace-tab-main"
              onClick={() => onActivate(path)}
            >
              <span className="workspace-tab-mark" aria-hidden="true">
                {label.charAt(0).toUpperCase()}
              </span>
              <span className="workspace-tab-label">{label}</span>
            </button>
            {!active && (
              <button
                type="button"
                className="workspace-tab-remove"
                aria-label={t('workspaceTabs.remove', { name: label })}
                onClick={() => onRemove(path)}
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            )}
          </div>
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
