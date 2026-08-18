import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveArchivalRecall } from '../../src/main/memory/archival-resolver';

const mocks = vi.hoisted(() => ({
  buildRecallProjection: vi.fn(),
  readConcept: vi.fn(),
}));

vi.mock('../../src/main/memory/recall', () => ({
  buildRecallProjection: mocks.buildRecallProjection,
}));

vi.mock('../../src/main/ofk/ofk-bundle', () => ({
  readConcept: mocks.readConcept,
}));

describe('resolveArchivalRecall', () => {
  beforeEach(() => {
    mocks.buildRecallProjection.mockReset();
    mocks.readConcept.mockReset();
  });

  it('复用 recall 命中并沿 ofkRef 补两条文档摘要', async () => {
    mocks.buildRecallProjection.mockReturnValue({
      text: '- [working_context] 历史决定：沿用 lazy 方案',
      entryIds: ['mem-1'],
      ofkRefs: ['memory/mem-1.md', 'memory/mem-2.md', 'memory/ignored.md'],
    });
    mocks.readConcept.mockResolvedValueOnce({
      isErr: () => false,
      value: '---\ntype: note\n---\n# 标题\n第一条补充摘要\n第二条',
    });
    mocks.readConcept.mockResolvedValueOnce({
      isErr: () => false,
      value: '# 文档\n第二条补充摘要',
    });

    const result = await resolveArchivalRecall({
      workspace: 'C:/workspace',
      query: '之前怎么定的',
      triggeredBy: 'history',
      reason: '用户在追问历史决策或既有事实',
      sources: ['memory', 'ofk'],
    });

    expect(mocks.buildRecallProjection).toHaveBeenCalledWith({
      workspace: 'C:/workspace',
      query: '之前怎么定的',
    });
    expect(mocks.readConcept).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      reason: '用户在追问历史决策或既有事实',
      triggeredBy: 'history',
      sources: ['memory', 'ofk'],
      query: '之前怎么定的',
      memoryEntryIds: ['mem-1'],
      ofkPaths: ['memory/mem-1.md', 'memory/mem-2.md'],
    });
    expect(result?.text).toContain('历史决定：沿用 lazy 方案');
    expect(result?.text).toContain('[ofk] memory/mem-1.md：第一条补充摘要(文档补充)');
    expect(result?.text).toContain('[ofk] memory/mem-2.md：第二条补充摘要(文档补充)');
  });

  it('session-start 只有 memory 源时仍返回 recall 文本', async () => {
    mocks.buildRecallProjection.mockReturnValue({
      text: '- [user_profile] 偏好：简洁',
      entryIds: ['mem-2'],
      ofkRefs: [],
    });

    const result = await resolveArchivalRecall({
      workspace: 'C:/workspace',
      triggeredBy: 'session-start',
      reason: '新会话首轮 warm-up recall',
      sources: ['memory'],
    });

    expect(result).toMatchObject({
      triggeredBy: 'session-start',
      sources: ['memory'],
      memoryEntryIds: ['mem-2'],
      ofkPaths: [],
    });
    expect(mocks.readConcept).not.toHaveBeenCalled();
  });

  it('无 recall 且无可补充文档时返回 null', async () => {
    mocks.buildRecallProjection.mockReturnValue({
      text: '',
      entryIds: [],
      ofkRefs: [],
    });

    const result = await resolveArchivalRecall({
      workspace: 'C:/workspace',
      query: '继续',
      triggeredBy: 'resume',
      reason: '用户在恢复或续接历史上下文',
      sources: ['memory', 'ofk'],
    });

    expect(result).toBeNull();
  });
});
