import { Archive, BookOpenCheck, CalendarDays, Cpu, LayoutDashboard, Settings } from 'lucide-react';
import type { JSX } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { type AppPage, useAppStore } from '@/lib/app-store';
import { cn } from '@/lib/utils';
import type { MessageKey } from '../shared/i18n-core';
import { useT } from './lib/i18n';

export interface NavItem {
  page?: AppPage;
  labelKey: MessageKey;
  icon: typeof LayoutDashboard;
  disabled?: boolean;
}

// 页面路由(design.md .1):工作台/今日/记忆/模型配置/设置/技能;今日页独立于工作区,
// 位于第 2 位(app-shell spec);记忆页第 3 位(phase3 6.9);技能页第 6 位
// (skill-manager V1, 图标栏入口)。仅保留真实页面入口,占位不再保留。
export const NAV_ITEMS: NavItem[] = [
  { page: 'workspace', labelKey: 'nav.workspace', icon: LayoutDashboard },
  { page: 'today', labelKey: 'nav.today', icon: CalendarDays },
  { page: 'memory', labelKey: 'nav.memory', icon: Archive },
  { page: 'providers', labelKey: 'nav.providers', icon: Cpu },
  { page: 'settings', labelKey: 'nav.settings', icon: Settings },
  { page: 'skills', labelKey: 'nav.skills', icon: BookOpenCheck },
];

export function IconBar({ collapsed }: { collapsed: boolean }): JSX.Element {
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const t = useT();

  return (
    <TooltipProvider delayDuration={300}>
      <nav
        className={cn(
          'flex shrink-0 flex-col items-center gap-1 overflow-hidden border-r border-line bg-paper-mid py-2 transition-[width] duration-200 ease-out motion-reduce:transition-none',
          collapsed ? 'w-0 border-r-0' : 'w-12',
        )}
        aria-label={t('iconBar.navLabel')}
      >
        {!collapsed &&
          NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const target = item.page;
            const active = item.page === page;
            const label = t(item.labelKey);
            return (
              <Tooltip key={item.labelKey}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={label}
                    aria-current={active ? 'page' : undefined}
                    disabled={item.disabled}
                    onClick={target ? () => setPage(target) : undefined}
                    className={cn('icon-nav-btn', active && 'icon-nav-btn-active')}
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{label}</TooltipContent>
              </Tooltip>
            );
          })}
      </nav>
    </TooltipProvider>
  );
}
