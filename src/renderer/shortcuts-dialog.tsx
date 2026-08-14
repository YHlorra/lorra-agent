import type { JSX } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { SLASH_COMMANDS } from '@/lib/slash-commands';
import type { MessageKey } from '../shared/i18n-core';
import { useT } from './lib/i18n';

interface ShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const SHORTCUTS: { keys: string; labelKey: MessageKey }[] = [
  { keys: 'Ctrl + P', labelKey: 'shortcuts.commandPalette' },
  { keys: 'Ctrl + B', labelKey: 'shortcuts.toggleIconBar' },
  { keys: 'Enter', labelKey: 'shortcuts.send' },
  { keys: 'Ctrl + Enter', labelKey: 'shortcuts.newline' },
];

// 快捷键参考(pi TUI /hotkeys):快捷键 + 斜杠命令一览。
export function ShortcutsDialog({ open, onOpenChange }: ShortcutsDialogProps): JSX.Element {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label={t('shortcuts.title')}>
        <h2 className="text-base font-semibold">{t('shortcuts.title')}</h2>
        <ul className="shortcut-list">
          {SHORTCUTS.map((s) => (
            <li key={s.keys}>
              <kbd className="shortcut-key">{s.keys}</kbd>
              <span>{t(s.labelKey)}</span>
            </li>
          ))}
        </ul>
        <h2 className="text-base font-semibold">{t('shortcuts.slashCommands')}</h2>
        <ul className="shortcut-list">
          {SLASH_COMMANDS.map((c) => (
            <li key={c.name}>
              <kbd className="shortcut-key">{c.hint}</kbd>
              <span>{t(c.descriptionKey)}</span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
