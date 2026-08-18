import {
  BookOpenCheck,
  ChevronsDownUp,
  Copy,
  Cpu,
  FileText,
  History,
  Keyboard,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Plus,
  Settings,
} from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { type AppPage, useAppStore } from '@/lib/app-store';
import { SLASH_COMMANDS, type SlashCommandName } from '@/lib/slash-commands';
import type { MessageKey } from '../shared/i18n-core';
import { useT } from './lib/i18n';

const PAGES: { page: AppPage; labelKey: MessageKey; icon: typeof LayoutDashboard }[] = [
  { page: 'workspace', labelKey: 'nav.workspace', icon: LayoutDashboard },
  { page: 'providers', labelKey: 'nav.providers', icon: Cpu },
  { page: 'settings', labelKey: 'nav.settings', icon: Settings },
];

const COMMAND_ICONS: Record<SlashCommandName, typeof Plus> = {
  new: Plus,
  compact: ChevronsDownUp,
  resume: History,
  model: Cpu,
  settings: Settings,
  quit: LogOut,
  hotkeys: Keyboard,
  copy: Copy,
  review: FileText,
  skill: BookOpenCheck,
};

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionHistory: LorraSessionInfo[];
  activeSessionId: string | null;
  onOpenSession: (sessionId: string) => void;
  onSelectFile: (fileId: string, name: string) => void;
  onCreateSession: () => void;
  onCommand: (command: SlashCommandName) => boolean | Promise<boolean>;
}

// Ctrl+P 全局快捷键。
export function useCommandPalette(): { open: boolean; setOpen: (open: boolean) => void } {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  return { open, setOpen };
}

// 命令面板(design.md .1):键盘直达切页面 / 切会话 / 打开文件。
export function CommandPalette(props: CommandPaletteProps): JSX.Element {
  const t = useT();
  const setPage = useAppStore((s) => s.setPage);
  const [files, setFiles] = useState<Array<{ id: string; name: string }>>([]);

  // 每次打开时拉一次根目录文件列表,供「打开文件」命令。
  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    void window.lorra.fs.tree({ directoryId: 'ws-root', depth: 1 }).then((res) => {
      if (cancelled || !res.ok || !res.value) return;
      setFiles(res.value.filter((n) => n.type === 'file'));
    });
    return () => {
      cancelled = true;
    };
  }, [props.open]);

  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      <CommandInput placeholder={t('commandPalette.placeholder')} />
      <CommandList>
        <CommandEmpty>{t('commandPalette.empty')}</CommandEmpty>
        <CommandGroup heading={t('commandPalette.group.commands')}>
          {SLASH_COMMANDS.map((c) => {
            const Icon = COMMAND_ICONS[c.name];
            return (
              <CommandItem
                key={c.name}
                onSelect={() => {
                  void props.onCommand(c.name);
                  props.onOpenChange(false);
                }}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                <span>{c.hint}</span>
                <span className="text-ink-muted">{t(c.descriptionKey)}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t('commandPalette.group.pages')}>
          {PAGES.map((p) => (
            <CommandItem
              key={p.page}
              onSelect={() => {
                setPage(p.page);
                props.onOpenChange(false);
              }}
            >
              <p.icon className="h-4 w-4" aria-hidden="true" />
              <span>{t(p.labelKey)}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t('commandPalette.group.sessions')}>
          <CommandItem
            onSelect={() => {
              props.onCreateSession();
              props.onOpenChange(false);
            }}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span>{t('commandPalette.newSession')}</span>
          </CommandItem>
          {props.sessionHistory
            .filter((s) => s.id !== props.activeSessionId)
            .map((s) => (
              <CommandItem
                key={s.id}
                onSelect={() => {
                  props.onOpenSession(s.id);
                  props.onOpenChange(false);
                }}
              >
                <MessageSquare className="h-4 w-4" aria-hidden="true" />
                <span>{s.firstMessage || s.name || s.id}</span>
              </CommandItem>
            ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t('commandPalette.group.files')}>
          {files.map((f) => (
            <CommandItem
              key={f.id}
              onSelect={() => {
                props.onSelectFile(f.id, f.name);
                props.onOpenChange(false);
              }}
            >
              <FileText className="h-4 w-4" aria-hidden="true" />
              <span>{f.name}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
