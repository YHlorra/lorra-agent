import type { JSX, ReactNode } from 'react';
import { useEffect } from 'react';
import { useAppStore } from '@/lib/app-store';
import { IconBar } from './icon-bar';

// 四区布局骨架(design.md .1):最左图标栏 + 页面内容区。
// 标题栏(titlebar)由 App 持有,窗口控制与工作区切换依赖 App 状态。
export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  const navCollapsed = useAppStore((s) => s.navCollapsed);
  const toggleNav = useAppStore((s) => s.toggleNav);

  // Ctrl/Cmd+B 折叠/展开图标栏;输入态不拦截(避免抢走 textarea 的粗体/粘贴快捷键)。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleNav();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleNav]);

  return (
    <div className="app-body">
      <IconBar collapsed={navCollapsed} />
      <div className="app-content">{children}</div>
    </div>
  );
}
