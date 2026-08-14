import { Eye, EyeOff } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { useT } from './lib/i18n';

interface TreeNode {
  id: string;
  name: string;
  type: 'file' | 'dir';
  hasChildren: boolean;
}

export interface FileTreeProps {
  rootId: string;
  selectedFileId: string | null;
  onSelect: (fileId: string, name: string) => void;
  /** 显示隐藏项(.git/.pi/.env* 等);默认 false。 */
  showHiddenFiles?: boolean;
  onToggleHidden?: () => void;
}

export function FileTree(props: FileTreeProps): JSX.Element {
  const t = useT();
  const [root, setRoot] = useState<TreeNode[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Record<string, TreeNode[]>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.lorra.fs
      .tree({ directoryId: props.rootId, depth: 1 })
      .then((res) => {
        if (cancelled) return;
        if (res.ok && res.value) setRoot(res.value);
        else setError(!res.ok ? res.error.message : t('fileTree.loadFailedTitle'));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [props.rootId]);

  async function toggle(node: TreeNode): Promise<void> {
    if (node.type !== 'dir') {
      props.onSelect(node.id, node.name);
      return;
    }
    const next = new Set(expanded);
    if (next.has(node.id)) {
      next.delete(node.id);
      setExpanded(next);
      return;
    }
    next.add(node.id);
    setExpanded(next);
    if (!children[node.id]) {
      const res = await window.lorra.fs.tree({ directoryId: node.id, depth: 1 });
      if (res.ok && res.value) {
        const data = res.value;
        setChildren((prev) => ({ ...prev, [node.id]: data }));
      }
    }
  }

  if (error) {
    return (
      <div role="tree" aria-label={t('fileTree.label')}>
        <p role="alert">
          {t('fileTree.loadFailedTitle')}：{error}
        </p>
      </div>
    );
  }
  if (!root) {
    return (
      <div role="tree" aria-label={t('fileTree.label')}>
        <p>{t('fileTree.loading')}</p>
      </div>
    );
  }
  if (root.length === 0) {
    return (
      <div role="tree" aria-label={t('fileTree.label')}>
        <p className="px-2.5 py-1 text-xs text-ink-tertiary">{t('fileTree.empty')}</p>
      </div>
    );
  }

  const visible = (nodes: TreeNode[]): TreeNode[] =>
    props.showHiddenFiles ? nodes : nodes.filter((n) => !n.name.startsWith('.'));

  return (
    <div role="tree" aria-label={t('fileTree.label')} className="flex flex-col gap-0.5">
      {props.onToggleHidden ? (
        <button
          type="button"
          className="file-tree-toggle"
          aria-label={props.showHiddenFiles ? t('fileTree.hideHidden') : t('fileTree.showHidden')}
          onClick={props.onToggleHidden}
          title={props.showHiddenFiles ? t('fileTree.hideHidden') : t('fileTree.showHidden')}
        >
          {props.showHiddenFiles ? (
            <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Eye className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </button>
      ) : null}
      {visible(root).length === 0 ? (
        <p className="px-2.5 py-1 text-xs text-ink-tertiary">{t('fileTree.empty')}</p>
      ) : (
        renderNodes(
          visible(root),
          expanded,
          children,
          props.selectedFileId,
          toggle,
          props.showHiddenFiles ?? false,
        )
      )}
    </div>
  );
}

function renderNodes(
  nodes: TreeNode[],
  expanded: Set<string>,
  children: Record<string, TreeNode[]>,
  selected: string | null,
  toggle: (n: TreeNode) => Promise<void>,
  showHidden: boolean,
): JSX.Element[] {
  return nodes.map((n) => {
    const isSelected = n.id === selected;
    if (n.type === 'file') {
      return (
        <button
          key={n.id}
          className={rowClass(isSelected)}
          role="treeitem"
          aria-selected={isSelected}
          type="button"
          onClick={() => void toggle(n)}
        >
          <span className="text-[10px] text-ink-muted" aria-hidden="true">
            ◇
          </span>
          <span className="truncate">{n.name}</span>
        </button>
      );
    }
    const isOpen = expanded.has(n.id);
    const childList = children[n.id];
    return (
      <div key={n.id}>
        <button
          className={rowClass(false)}
          role="treeitem"
          aria-expanded={isOpen}
          type="button"
          onClick={() => void toggle(n)}
        >
          <span className="text-[10px] text-ink-muted" aria-hidden="true">
            {isOpen ? '▾' : '▸'}
          </span>
          <span className="truncate font-medium">{n.name}</span>
        </button>
        {isOpen && childList && (
          <div className="ml-3.5 flex flex-col gap-0.5">
            {renderNodes(
              showHidden ? childList : childList.filter((c) => !c.name.startsWith('.')),
              expanded,
              children,
              selected,
              toggle,
              showHidden,
            )}
          </div>
        )}
      </div>
    );
  });
}

function rowClass(selected: boolean): string {
  return cn(
    'flex w-full items-center gap-2 rounded-kami px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-paper/70',
    selected && 'bg-overlay text-navy',
  );
}
