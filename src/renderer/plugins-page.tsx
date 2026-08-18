import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { AgentPluginInfo, McpServerInfo, PluginsXray } from '../shared/plugins-api';
import type { LorraError } from '../shared/result';
import { SkillsPage } from './skills-page';

/**
 * 插件页（plan S5）：统一管理 Skills / MCP / Plugins 三态。
 * 页头标题「插件」+ 副标题计数 + 右对齐 Segmented Control 切三态；
 * 返回导航由左侧栏承担，页头不再设返回钮（2026-08-15 去双返回键）；
 * 三态内容包在 .plugins-shell 圆角卡内，与页头软分界不割裂。
 */

export interface PluginsPageProps {
  onOpenFile?: (target: string) => void;
}

type Pane = 'skills' | 'mcp' | 'plugins';

const PANES: Array<{ id: Pane; label: string }> = [
  { id: 'skills', label: '技能' },
  { id: 'mcp', label: 'MCP' },
  { id: 'plugins', label: '插件' },
];

export function PluginsPage({ onOpenFile }: PluginsPageProps): JSX.Element {
  const [pane, setPane] = useState<Pane>('skills');
  const [xray, setXray] = useState<PluginsXray | null>(null);
  const [error, setError] = useState<LorraError | null>(null);

  const fetchXray = useCallback(async (): Promise<void> => {
    try {
      const res = await window.lorra.agentPlugins.xray();
      if (res.ok) setXray(res.value);
      else setError(res.error);
    } catch {
      // 插件/MCP 数据拉取失败不阻断技能态（SkillsPage 独立拉取）。
    }
  }, []);

  const didMount = useRef(false);
  useEffect(() => {
    if (didMount.current) return;
    didMount.current = true;
    void fetchXray();
  }, [fetchXray]);

  const mcpCount = xray?.mcps.length ?? 0;

  const pluginCount = xray?.plugins.length ?? 0;

  return (
    <main className="skills-page plugins-page" data-testid="plugins-page">
      <header className="skills-head plugins-head">
        <div className="head-title">
          <h1>插件</h1>
          {pane !== 'skills' && (
            <span className="skills-sub" data-testid="plugins-subtitle">
              {pane === 'mcp' ? '共 ' + mcpCount + ' 个 MCP' : '共 ' + pluginCount + ' 个插件'}
            </span>
          )}
        </div>
        <div className="plugins-seg" role="tablist" aria-label="插件类别">
          {PANES.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={pane === p.id}
              className={cn('plg-seg-btn', pane === p.id && 'active')}
              data-testid="plugins-tab"
              data-pane={p.id}
              onClick={() => setPane(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </header>

      <div className="plugins-shell">
        {pane === 'skills' && <SkillsPage embedded onOpenFile={onOpenFile} />}
        {pane === 'mcp' && <McpPane xray={xray} error={error} onRefresh={() => void fetchXray()} />}
        {pane === 'plugins' && (
          <PluginsPane xray={xray} error={error} onRefresh={() => void fetchXray()} />
        )}
      </div>
    </main>
  );
}

/** MCP 态：高密度列表（名称/类型/来源/状态/toggle）。 */
function McpPane({
  xray,
  error,
  onRefresh,
}: {
  xray: PluginsXray | null;
  error: LorraError | null;
  onRefresh: () => void;
}): JSX.Element {
  const mcps = xray?.mcps ?? [];
  if (error) {
    return (
      <div className="skills-empty">
        <div className="e-title">MCP 读取失败</div>
        <div className="e-sub">{error.message}</div>
      </div>
    );
  }
  if (mcps.length === 0) {
    return (
      <div className="skills-empty">
        <div className="e-title">还没有 MCP 服务器</div>
        <div className="e-sub">
          安装含 mcp.json 的 agent-plugin 后，其 MCP 服务器会自动出现在这里。
        </div>
      </div>
    );
  }
  return (
    <div className="skills-scroll">
      <Table data-testid="plugins-mcp-table">
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead>
            <TableHead>类型</TableHead>
            <TableHead>来源</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className="c">启用</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {mcps.map((m: McpServerInfo) => {
            const toggle = (
              <label
                className={cn('sk-tg', m.enabled && 'on', m.origin === 'plugin' && 'disabled')}
              >
                <input
                  type="checkbox"
                  data-testid="plugins-mcp-toggle"
                  data-id={m.id}
                  checked={m.enabled}
                  disabled={m.origin === 'plugin'}
                  onChange={() => void toggleMcp(m, onRefresh)}
                />
                <span className="sk-tg-track" aria-hidden="true" />
              </label>
            );
            return (
              <TableRow key={m.id} data-testid="plugins-mcp-row" data-id={m.id}>
                <TableCell>
                  <span className="sk-skill-name">{m.id}</span>
                </TableCell>
                <TableCell>
                  <span className="sk-pos">{m.type}</span>
                </TableCell>
                <TableCell>
                  <span className="sk-pos">
                    {m.origin === 'plugin' ? '插件 ' + m.pluginName : '用户'}
                  </span>
                </TableCell>
                <TableCell>{mcpHealthBadge(m)}</TableCell>
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: 纯 stopPropagation 容器，键盘语义由内部 checkbox 承担 */}
                <TableCell className="c" onClick={(e) => e.stopPropagation()}>
                  {toggle}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/** Plugins 态：高密度列表 + 导入/新建。 */
function PluginsPane({
  xray,
  error,
  onRefresh,
}: {
  xray: PluginsXray | null;
  error: LorraError | null;
  onRefresh: () => void;
}): JSX.Element {
  const plugins = xray?.plugins ?? [];
  const [importOpen, setImportOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  if (error) {
    return (
      <div className="skills-empty">
        <div className="e-title">插件读取失败</div>
        <div className="e-sub">{error.message}</div>
      </div>
    );
  }
  return (
    <div className="skills-scroll">
      <div className="plg-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          data-testid="plugins-import"
          onClick={() => setImportOpen(true)}
        >
          导入
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          data-testid="plugins-create"
          onClick={() => setCreateOpen(true)}
        >
          新建
        </button>
      </div>
      {plugins.length === 0 ? (
        <div className="skills-empty">
          <div className="e-title">还没有插件</div>
          <div className="e-sub">点「导入」装入 agent-plugins 目录，或「新建」脚手架。</div>
        </div>
      ) : (
        <Table data-testid="plugins-plugin-table">
          <TableHeader>
            <TableRow>
              <TableHead>插件</TableHead>
              <TableHead>版本</TableHead>
              <TableHead className="c">技能数</TableHead>
              <TableHead className="c">MCP 数</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="c">启用</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {plugins.map((p: AgentPluginInfo) => (
              <TableRow key={p.name} data-testid="plugins-plugin-row" data-name={p.name}>
                <TableCell>
                  <span className="sk-skill-name">
                    {p.name}
                    {p.description && <span className="skills-sub"> · {p.description}</span>}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="sk-pos">{p.version ?? '—'}</span>
                </TableCell>
                <TableCell className="c">
                  <span className="sk-count">{p.skillCount}</span>
                </TableCell>
                <TableCell className="c">
                  <span className="sk-count">{p.mcpCount}</span>
                </TableCell>
                <TableCell>
                  {p.issues.length > 0 ? (
                    <Badge variant="issue">有问题</Badge>
                  ) : (
                    <span className="sk-pos">正常</span>
                  )}
                </TableCell>
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: 纯 stopPropagation 容器，键盘语义由内部 checkbox 承担 */}
                <TableCell className="c" onClick={(e) => e.stopPropagation()}>
                  <label className={cn('sk-tg', p.enabled && 'on')}>
                    <input
                      type="checkbox"
                      data-testid="plugins-plugin-toggle"
                      data-name={p.name}
                      checked={p.enabled}
                      onChange={() => void togglePlugin(p, onRefresh)}
                    />
                    <span className="sk-tg-track" aria-hidden="true" />
                  </label>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {importOpen && (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onDone={() => {
            setImportOpen(false);
            onRefresh();
          }}
        />
      )}
      {createOpen && (
        <CreateDialog
          onClose={() => setCreateOpen(false)}
          onDone={() => {
            setCreateOpen(false);
            onRefresh();
          }}
        />
      )}
    </div>
  );
}

async function toggleMcp(m: McpServerInfo, onRefresh: () => void): Promise<void> {
  const res = await window.lorra.agentPlugins.mcpSetEnabled(m.id, !m.enabled);
  if (res.ok) onRefresh();
}

async function togglePlugin(p: AgentPluginInfo, onRefresh: () => void): Promise<void> {
  const res = await window.lorra.agentPlugins.setPluginEnabled(p.name, !p.enabled);
  if (res.ok) onRefresh();
}

function mcpHealthBadge(m: McpServerInfo): JSX.Element {
  const map: Record<string, string> = {
    ok: '已连接',
    error: '失败',
    unverified: '待验证',
    unsupported: '未支持',
  };
  const cls = m.health === 'ok' ? 'sk-b-inner' : m.health === 'error' ? 'sk-b-issue' : 'sk-b-inner';
  return <span className={cn('sk-b', cls)}>{map[m.health] ?? m.health}</span>;
}

/** 导入弹层：本地目录路径输入。 */
function ImportDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [source, setSource] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const doImport = async (): Promise<void> => {
    const res = await window.lorra.agentPlugins.importFolder(source.trim());
    if (res.ok) onDone();
    else setErr(res.error.message);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="skills-detail" data-testid="plugins-import-dialog">
        <div className="sk-detail-head">
          <h2 className="sk-detail-name">导入插件</h2>
        </div>
        <input
          className="plg-input"
          data-testid="plugins-import-source"
          placeholder="插件目录绝对路径（含 plugin.json）"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
        {err && <div className="skills-action-error">{err}</div>}
        <div className="sk-detail-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="plugins-import-confirm"
            disabled={source.trim() === ''}
            onClick={() => void doImport()}
          >
            导入
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 新建弹层：插件名 → 脚手架。 */
function CreateDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const doCreate = async (): Promise<void> => {
    const res = await window.lorra.agentPlugins.create(name.trim());
    if (res.ok) onDone();
    else setErr(res.error.message);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="skills-detail" data-testid="plugins-create-dialog">
        <div className="sk-detail-head">
          <h2 className="sk-detail-name">新建插件</h2>
        </div>
        <input
          className="plg-input"
          data-testid="plugins-create-name"
          placeholder="插件名（1-64 位小写字母/数字/点/连字符）"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {err && <div className="skills-action-error">{err}</div>}
        <div className="sk-detail-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="plugins-create-confirm"
            disabled={name.trim() === ''}
            onClick={() => void doCreate()}
          >
            创建
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
