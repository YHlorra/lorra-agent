/**
 * 会话内记忆只读展示卡(1.6)黑盒测试。
 *
 * 规范真源:
 * - 派工契约 1.6:候选闸门拆除后,会话内不再渲染可操作卡片;
 * MemoryCard 为纯展示:类别/scope/来源/证据徽标 + 标题 + 内容 +
 * producer/依据,无任何按钮。
 * - 生效区条目的编辑/撤销按钮由记忆页提供(触点③),不在此卡片内。
 *
 * 钩子契约:
 * data-testid="memory-card" + data-entry-id 卡片容器(article)
 * .memory-card-head 内四枚徽标(类别/scope/来源/证据)
 * .memory-card-foot 内 producer/依据
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MemoryCard } from '../../src/renderer/memory-card';
import {
  MEMORY_EVIDENCE_LABELS,
  MEMORY_KIND_LABELS,
  MEMORY_SCOPE_LABELS,
  MEMORY_SOURCE_LABELS,
  type MemoryEntry,
  type MemoryEvidence,
  type MemoryKind,
  type MemoryScope,
  type MemorySource,
} from '../../src/shared/memory-schema';

function makeEntry(over: Partial<MemoryEntry> & { entryId: string }): MemoryEntry {
  return {
    schemaVersion: 1,
    tags: [],
    kind: 'hard_policy',
    title: '默认标题',
    content: '默认内容',
    producer: 'memory',
    source: 'agent-proposal',
    scope: 'workspace',
    workspace: 'ws-1',
    evidence: 'user-stated',
    basis: '',
    lifecycle: 'active',
    supersedes: null,
    createdAt: 1,
    updatedAt: 1,
    confirmedAt: 1,
    ofkRef: null,
    ...over,
  };
}

// =========================================================================
// 渲染:徽标映射 + 内容展示(纯只读)
// =========================================================================

describe('MemoryCard 只读展示', () => {
  it('六类各一张卡片 → 各自显示对应类别标签', () => {
    const kinds: MemoryKind[] = [
      'hard_policy',
      'soft_preference',
      'procedural_experience',
      'run_bound_feedback',
      'working_context',
      'knowledge',
    ];
    for (const [i, kind] of kinds.entries()) {
      render(<MemoryCard entry={makeEntry({ entryId: `e${i}`, kind })} />);
    }
    for (const kind of kinds) {
      expect(screen.getAllByText(MEMORY_KIND_LABELS[kind]).length).toBeGreaterThan(0);
    }
  });

  it('四证据徽标正确映射(MEMORY_EVIDENCE_LABELS)', () => {
    const evidences: MemoryEvidence[] = ['user-stated', 'extracted', 'inferred', 'unverified'];
    for (const [i, evidence] of evidences.entries()) {
      render(<MemoryCard entry={makeEntry({ entryId: `e${i}`, evidence })} />);
    }
    for (const evidence of evidences) {
      expect(screen.getAllByText(MEMORY_EVIDENCE_LABELS[evidence]).length).toBeGreaterThan(0);
    }
  });

  it('scope 徽标正确映射(MEMORY_SCOPE_LABELS)', () => {
    const scopes: MemoryScope[] = ['user', 'workspace', 'project', 'agent'];
    for (const [i, scope] of scopes.entries()) {
      render(<MemoryCard entry={makeEntry({ entryId: `e${i}`, scope })} />);
    }
    for (const scope of scopes) {
      expect(screen.getAllByText(MEMORY_SCOPE_LABELS[scope]).length).toBeGreaterThan(0);
    }
  });

  it('来源徽标正确映射(MEMORY_SOURCE_LABELS)', () => {
    const sources: MemorySource[] = [
      'agent-proposal',
      'review-distillation',
      'material-digestion',
      'user-crystallization',
    ];
    for (const [i, source] of sources.entries()) {
      render(<MemoryCard entry={makeEntry({ entryId: `e${i}`, source })} />);
    }
    for (const source of sources) {
      expect(screen.getAllByText(MEMORY_SOURCE_LABELS[source]).length).toBeGreaterThan(0);
    }
  });

  it('卡片展示 title/content/producer/依据', () => {
    render(
      <MemoryCard
        entry={makeEntry({
          entryId: 'e1',
          title: '禁删根目录',
          content: '任何情况下不得执行 rm -rf /',
          producer: 'assistant/sub-1',
          basis: '用户原话:永远别删根目录',
        })}
      />,
    );
    expect(screen.getByText('禁删根目录')).toBeInTheDocument();
    expect(screen.getByText('任何情况下不得执行 rm -rf /')).toBeInTheDocument();
    expect(screen.getByText('来源：assistant/sub-1')).toBeInTheDocument();
    expect(screen.getByText('依据：用户原话:永远别删根目录')).toBeInTheDocument();
  });

  it('无任何操作按钮(确认/编辑/拒绝/忽略全部移除)', () => {
    render(<MemoryCard entry={makeEntry({ entryId: 'e1' })} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    for (const label of ['确认', '编辑', '拒绝', '忽略']) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it('无依据 → 不渲染「依据:」行', () => {
    render(<MemoryCard entry={makeEntry({ entryId: 'e1', basis: '' })} />);
    expect(screen.getByText('来源：memory')).toBeInTheDocument();
    expect(screen.queryByText(/^依据：/)).toBeNull();
  });
});
