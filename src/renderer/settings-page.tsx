import { FolderCog, Info, Palette, Plug, Tags } from 'lucide-react';
import { type JSX, useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { useAppStore } from './lib/app-store';
import { useT } from './lib/i18n';
import { SHORTCUTS } from './shortcuts-dialog';

/**
 * 设置页(/ PRD 设置节):左栏分组导航 + 右面板,与模型配置页同构。
 * 分组:外观 / 工作区 / 数据源 / 标签 / 关于。
 * 全部文案走 useT 词条,禁止硬编码。
 */

type SettingsGroup = 'appearance' | 'workspace' | 'dataSources' | 'tags' | 'about';

export function SettingsPage(): JSX.Element {
  const t = useT();
  const [group, setGroup] = useState<SettingsGroup>('appearance');
  const [licensesOpen, setLicensesOpen] = useState(false);

  const navGroups: Array<{ id: SettingsGroup; label: string; icon: typeof Palette }> = [
    { id: 'appearance', label: t('settings.groups.appearance'), icon: Palette },
    { id: 'workspace', label: t('settings.groups.workspace'), icon: FolderCog },
    { id: 'dataSources', label: t('settings.groups.dataSources'), icon: Plug },
    { id: 'tags', label: t('settings.groups.tags'), icon: Tags },
    { id: 'about', label: t('settings.groups.about'), icon: Info },
  ];

  return (
    <main className="settings-page" aria-label={t('settings.title')}>
      <nav className="settings-nav" aria-label={t('settings.title')}>
        {navGroups.map((g) => {
          const Icon = g.icon;
          const active = group === g.id;
          return (
            <button
              key={g.id}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => setGroup(g.id)}
              className={cn('settings-nav-item', active && 'settings-nav-item-active')}
            >
              <Icon className="settings-nav-icon" aria-hidden="true" />
              {g.label}
            </button>
          );
        })}
      </nav>
      <section className="settings-content" aria-label={t('settings.title')}>
        {group === 'appearance' && <AppearanceSection />}
        {group === 'workspace' && <WorkspaceSection />}
        {group === 'dataSources' && <DataSourcesSection />}
        {group === 'tags' && <TagsSection />}
        {group === 'about' &&
          (licensesOpen ? (
            <LicensesSection onBack={() => setLicensesOpen(false)} />
          ) : (
            <AboutSection onOpenLicenses={() => setLicensesOpen(true)} />
          ))}
      </section>
    </main>
  );
}

// ── 行控件:开关(role=switch)与单选(role=radio)──

interface ToggleRowProps {
  title: string;
  desc?: string;
  checked: boolean;
  onToggle: () => void;
}

function ToggleRow({ title, desc, checked, onToggle }: ToggleRowProps): JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <span className="settings-row-title">{title}</span>
        {desc && <span className="settings-row-desc">{desc}</span>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        onClick={onToggle}
        className={cn('settings-switch', checked && 'settings-switch-on')}
      >
        <span className="settings-switch-thumb" aria-hidden="true" />
      </button>
    </div>
  );
}

interface ChoiceRowProps {
  title: string;
  desc?: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}

function ChoiceRow({ title, desc, value, options, onChange }: ChoiceRowProps): JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <span className="settings-row-title">{title}</span>
        {desc && <span className="settings-row-desc">{desc}</span>}
      </div>
      <div className="settings-choices" role="radiogroup" aria-label={title}>
        {options.map((opt) => (
          // biome-ignore lint/a11y/useSemanticElements: 单选胶囊按钮组按 role=radio 契约渲染(settings-page 测试与 验收钉死),按钮原生语义不适用
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={value === opt.value}
            onClick={() => onChange(opt.value)}
            className={cn('settings-choice', value === opt.value && 'settings-choice-active')}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── 外观 ───────────────────────────────────────────────────────────────────

function AppearanceSection(): JSX.Element {
  const t = useT();
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const navCollapsed = useAppStore((s) => s.navCollapsed);
  const toggleNav = useAppStore((s) => s.toggleNav);
  const defaultHideThinking = useAppStore((s) => s.defaultHideThinking);
  const setDefaultHideThinking = useAppStore((s) => s.setDefaultHideThinking);
  const language = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);

  return (
    <div className="settings-rows">
      <ChoiceRow
        title={t('settings.appearance.theme')}
        desc={t('settings.appearance.theme.desc')}
        value={theme}
        options={[
          { value: 'light', label: t('settings.appearance.theme.light') },
          { value: 'dark', label: t('settings.appearance.theme.dark') },
        ]}
        onChange={(v) => setTheme(v as 'light' | 'dark')}
      />
      <ToggleRow
        title={t('settings.appearance.navCollapsed')}
        desc={t('settings.appearance.navCollapsed.desc')}
        checked={navCollapsed}
        onToggle={toggleNav}
      />
      <ToggleRow
        title={t('settings.appearance.hideThinking')}
        desc={t('settings.appearance.hideThinking.desc')}
        checked={defaultHideThinking}
        onToggle={() => setDefaultHideThinking(!defaultHideThinking)}
      />
      <ChoiceRow
        title={t('settings.appearance.language')}
        desc={t('settings.appearance.language.desc')}
        value={language}
        options={[
          { value: 'zh', label: t('settings.appearance.language.zh') },
          { value: 'en', label: t('settings.appearance.language.en') },
        ]}
        onChange={(v) => setLanguage(v as 'zh' | 'en')}
      />
    </div>
  );
}

// ── 工作区 ─────────────────────────────────────────────────────────────────

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

function WorkspaceSection(): JSX.Element {
  const t = useT();
  const showHiddenFiles = useAppStore((s) => s.showHiddenFiles);
  const setShowHiddenFiles = useAppStore((s) => s.setShowHiddenFiles);
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [removeError, setRemoveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.lorra.workspace
      .list()
      .then((result) => {
        if (!cancelled) setWorkspaces(result.workspaces);
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const removeWorkspace = useCallback(
    async (wsPath: string) => {
      try {
        const result = await window.lorra.workspace.remove(wsPath);
        setWorkspaces(result.workspaces);
        setRemoveError(null);
      } catch {
        setRemoveError(t('settings.workspace.recent.removeError', { name: baseName(wsPath) }));
      }
    },
    [t],
  );

  return (
    <div className="settings-rows">
      <ToggleRow
        title={t('settings.workspace.hiddenFiles')}
        desc={t('settings.workspace.hiddenFiles.desc')}
        checked={showHiddenFiles}
        onToggle={() => setShowHiddenFiles(!showHiddenFiles)}
      />
      <div className="settings-row settings-row-stacked">
        <div className="settings-row-info">
          <span className="settings-row-title">{t('settings.workspace.recent')}</span>
          <span className="settings-row-desc">{t('settings.workspace.recent.desc')}</span>
        </div>
        <ul className="settings-recent">
          {workspaces.length === 0 && (
            <li className="settings-recent-empty">{t('settings.workspace.recent.empty')}</li>
          )}
          {workspaces.map((wsPath, index) => (
            <li key={wsPath} className="settings-recent-item" title={wsPath}>
              <span className="settings-recent-name">{baseName(wsPath)}</span>
              {index === 0 ? (
                <span className="settings-recent-current">
                  {t('settings.workspace.recent.current')}
                </span>
              ) : (
                <button
                  type="button"
                  className="settings-recent-remove"
                  onClick={() => void removeWorkspace(wsPath)}
                >
                  {t('settings.workspace.recent.remove')}
                </button>
              )}
            </li>
          ))}
        </ul>
        {removeError && (
          <p className="settings-inline-error" role="alert">
            {removeError}
          </p>
        )}
      </div>
    </div>
  );
}

// ── 数据源────────────────────────────────────────────────────────

interface PluginListItem {
  name: string;
  runtime: string;
  description: string;
  status: 'ok' | 'error';
  error?: string;
}

const DATA_SOURCE_ROWS: ReadonlyArray<{
  runtime: 'claudeCode' | 'opencode' | 'ohMyPi' | 'workbuddy';
  labelKey:
    | 'settings.dataSources.claudeCode'
    | 'settings.dataSources.opencode'
    | 'settings.dataSources.ohMyPi'
    | 'settings.dataSources.workbuddy';
}> = [
  { runtime: 'claudeCode', labelKey: 'settings.dataSources.claudeCode' },
  { runtime: 'opencode', labelKey: 'settings.dataSources.opencode' },
  { runtime: 'ohMyPi', labelKey: 'settings.dataSources.ohMyPi' },
  { runtime: 'workbuddy', labelKey: 'settings.dataSources.workbuddy' },
];

function DataSourcesSection(): JSX.Element {
  const t = useT();
  const dataSources = useAppStore((s) => s.dataSources);
  const setDataSource = useAppStore((s) => s.setDataSource);
  const hydrateDataSources = useAppStore((s) => s.hydrateDataSources);
  const [plugins, setPlugins] = useState<PluginListItem[] | null>(null);

  // 挂载时从 settings.json 读真源水合开关(重启后回显持久化值;纯读,不写回)。
  useEffect(() => {
    let cancelled = false;
    void window.lorra.settings
      .get()
      .then((result) => {
        if (!cancelled && result.ok) hydrateDataSources(result.value.dataSources);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [hydrateDataSources]);

  // 挂载时拉取插件清单;失败 → null(显示空态)。
  useEffect(() => {
    let cancelled = false;
    void window.lorra.plugins
      .list()
      .then((res) => {
        if (cancelled || !res.ok) return;
        setPlugins(res.value.plugins);
      })
      .catch(() => {
        if (!cancelled) setPlugins([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="settings-rows">
      <div className="settings-row-info settings-row-info-wide">
        <span className="settings-row-title">{t('settings.groups.dataSources')}</span>
        <span className="settings-row-desc">{t('settings.dataSources.desc')}</span>
      </div>
      {DATA_SOURCE_ROWS.map(({ runtime, labelKey }) => (
        <ToggleRow
          key={runtime}
          title={t(labelKey)}
          desc={t('settings.dataSources.desc')}
          checked={dataSources[runtime]}
          onToggle={() => setDataSource(runtime, !dataSources[runtime])}
        />
      ))}
      <div className="settings-section-title">{t('settings.dataSources.plugins')}</div>
      {plugins === null ? (
        <p className="pc-muted">{t('providers.loading')}</p>
      ) : plugins.length === 0 ? (
        <p className="pc-muted">{t('settings.dataSources.plugins.empty')}</p>
      ) : (
        <ul className="settings-plugin-list" data-testid="settings-plugins">
          {plugins.map((p) => (
            <li key={p.name} className="settings-plugin-row">
              <span className="settings-plugin-name">{p.name}</span>
              <span className="settings-plugin-desc">{p.description}</span>
              {p.status === 'error' && (
                <span className="settings-plugin-error">
                  {t('settings.dataSources.plugins.error', { error: p.error ?? '' })}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── 标签(2026-08-14 今日页标签分类改造)────────────────────────────────

/**
 * 标签管理:内置默认 + 用户自定义的完整列表(settings.get 真源);
 * 每次增删即 settings.set({ tags }) 持久化并本地 setState。
 * 输入 trim 后为空 / 与现有重复 → 忽略。
 */
function TagsSection(): JSX.Element {
  const t = useT();
  const [tags, setTags] = useState<string[]>([]);
  const [input, setInput] = useState('');

  // 挂载时读真源(settings.get;失败 → 空列表,不打断页面)。
  useEffect(() => {
    let cancelled = false;
    void window.lorra.settings
      .get()
      .then((result) => {
        if (!cancelled && result.ok) setTags(result.value.tags ?? []);
      })
      .catch(() => {
        if (!cancelled) setTags([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const addTag = useCallback(() => {
    const next = input.trim();
    setInput('');
    if (next === '' || tags.includes(next)) return;
    const updated = [...tags, next];
    setTags(updated);
    void window.lorra.settings.set({ tags: updated }).catch(() => {
      // fail-open:持久化失败不回滚本地态(下次打开恢复真源)。
    });
  }, [input, tags]);

  const removeTag = useCallback(
    (tag: string) => {
      const updated = tags.filter((x) => x !== tag);
      setTags(updated);
      void window.lorra.settings.set({ tags: updated }).catch(() => {
        // fail-open:同 addTag。
      });
    },
    [tags],
  );

  return (
    <div className="settings-rows">
      <div className="settings-row-info settings-row-info-wide">
        <span className="settings-row-title">{t('settings.groups.tags')}</span>
        <span className="settings-row-desc">{t('settings.tags.desc')}</span>
      </div>
      <div className="settings-tags" data-testid="settings-tags">
        {tags.map((tag) => (
          <span key={tag} className="settings-tag" data-testid="tag-chip">
            {tag}
            <button
              type="button"
              className="settings-tag-remove"
              aria-label={t('settings.tags.remove', { tag })}
              onClick={() => removeTag(tag)}
            >
              ×
            </button>
          </span>
        ))}
        {tags.length === 0 && <p className="pc-muted">{t('settings.tags.empty')}</p>}
      </div>
      <div className="settings-tag-add">
        <input
          type="text"
          className="settings-tag-input"
          data-testid="tag-input"
          placeholder={t('settings.tags.placeholder')}
          aria-label={t('settings.tags.placeholder')}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addTag();
          }}
        />
        <button type="button" className="settings-choice" data-testid="tag-add" onClick={addTag}>
          {t('settings.tags.add')}
        </button>
      </div>
    </div>
  );
}

// ── 关于 ───────────────────────────────────────────────────────────────────

function AboutSection({ onOpenLicenses }: { onOpenLicenses: () => void }): JSX.Element {
  const t = useT();
  const [appInfo, setAppInfo] = useState<{ version: string; name: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.lorra.app
      .info()
      .then((info) => {
        if (!cancelled) setAppInfo(info);
      })
      .catch(() => {
        if (!cancelled) setAppInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="settings-rows">
      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-title">{t('settings.about.version')}</span>
        </div>
        <span className="settings-row-value">{appInfo?.version ?? '—'}</span>
      </div>
      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-title">{t('settings.about.openSource')}</span>
          <span className="settings-row-desc">{t('settings.about.openSource.desc')}</span>
        </div>
        <button type="button" className="settings-choice" onClick={onOpenLicenses}>
          {t('settings.licenses.open')}
        </button>
      </div>
      <div className="settings-row settings-row-stacked">
        <div className="settings-row-info">
          <span className="settings-row-title">{t('settings.about.shortcuts')}</span>
          <span className="settings-row-desc">{t('settings.about.shortcuts.desc')}</span>
        </div>
        <ul className="settings-shortcuts">
          {SHORTCUTS.map((s) => (
            <li key={s.keys} className="settings-shortcut">
              <kbd className="settings-shortcut-key">{s.keys}</kbd>
              <span>{t(s.labelKey)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ── 关于 → 开源项目 ─────────────────────────────────────────────────────────

/** 开源项目页:搜索 + 列表 + 仓库/包地址链接(数据源构建期 licenses.json)。 */
function LicensesSection({ onBack }: { onBack: () => void }): JSX.Element {
  const t = useT();
  const [projects, setProjects] = useState<OpenSourceProject[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    void window.lorra.app
      .licenses()
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch(() => {
        if (!cancelled) {
          setProjects([]);
          setLoadFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const q = query.trim().toLowerCase();
  const filtered =
    projects === null
      ? []
      : q
        ? projects.filter(
            (p) =>
              p.name.toLowerCase().includes(q) ||
              p.license.toLowerCase().includes(q) ||
              (p.repository ?? '').toLowerCase().includes(q) ||
              (p.homepage ?? '').toLowerCase().includes(q),
          )
        : projects;

  return (
    <div className="settings-rows">
      <div className="licenses-toolbar">
        <button type="button" className="settings-choice" onClick={onBack}>
          {t('settings.licenses.back')}
        </button>
        <input
          type="search"
          className="licenses-search"
          placeholder={t('settings.licenses.search.placeholder')}
          aria-label={t('settings.licenses.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <h2 className="settings-section-title">{t('settings.licenses.title')}</h2>
      {loadFailed ? (
        <p className="licenses-status" role="alert">
          {t('settings.licenses.error')}
        </p>
      ) : projects === null ? (
        <p className="licenses-status">{t('settings.licenses.loading')}</p>
      ) : projects.length === 0 ? (
        <p className="licenses-status">{t('settings.licenses.empty')}</p>
      ) : filtered.length === 0 ? (
        <p className="licenses-status">{t('settings.licenses.noMatch')}</p>
      ) : (
        <ul className="licenses-list">
          {filtered.map((p) => (
            <li key={p.name} className="licenses-item">
              <div className="licenses-info">
                <span className="licenses-name">{p.name}</span>
                <span className="licenses-meta">
                  {p.version} · <span className="licenses-badge">{p.license}</span>
                </span>
              </div>
              <div className="licenses-links">
                {p.repository !== null && (
                  <a
                    href={p.repository}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={t('settings.licenses.repository', { name: p.name })}
                  >
                    {t('settings.licenses.repository')}
                  </a>
                )}
                <a
                  href={`https://www.npmjs.com/package/${p.name}`}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t('settings.licenses.package', { name: p.name })}
                >
                  {t('settings.licenses.package')}
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
