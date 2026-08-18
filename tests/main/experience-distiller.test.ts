import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listExperienceCases } from '../../src/main/memory/experience-distiller';
import type { MemoryEntry } from '../../src/shared/memory-schema';
import type { Result } from '../../src/shared/result';

const { fakeStore } = vi.hoisted(() => ({
  fakeStore: {
    entries: [] as MemoryEntry[],
    failMode: 'ok' as 'ok' | 'err',
  },
}));

vi.mock('../../src/main/memory/shared-memory-store', () => ({
  getSharedMemoryStore: () => {
    if (fakeStore.failMode === 'err') {
      return { isErr: () => true, error: { code: 'db-down', message: 'db unavailable' } };
    }
    return {
      isErr: () => false,
      value: {
        listActive: () => ({ isErr: () => false, value: fakeStore.entries }),
      },
    };
  },
}));

function expectOk<T>(result: Result<T>): T {
  expect(result.isOk()).toBe(true);
  return result.match({
    ok: (value) => value,
    err: () => {
      throw new Error('expected Ok, got Err');
    },
  });
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    entryId: 'mem-1',
    schemaVersion: 1,
    kind: 'procedural_experience',
    title: '排查登录超时',
    content: '先看日志\n\n- 必须保留最小 diff\n- 注意不要重置用户数据',
    tags: [],
    producer: 'agent',
    source: 'agent-proposal',
    scope: 'workspace',
    workspace: 'C:/workspace',
    evidence: 'extracted',
    basis: 'review',
    lifecycle: 'active',
    supersedes: null,
    createdAt: 1,
    updatedAt: 2,
    confirmedAt: 2,
    ofkRef: null,
    ...overrides,
  };
}

describe('listExperienceCases', () => {
  beforeEach(() => {
    fakeStore.entries = [];
    fakeStore.failMode = 'ok';
  });

  it('从 procedural_experience 派生 case，并提取首段与约束', () => {
    fakeStore.entries = [
      makeEntry({
        entryId: 'mem-1',
        title: '排查登录超时 2026-08-17',
        content: '先看请求日志\n\n- 必须先复现\n- 注意不要扩大改动',
      }),
    ];

    const cases = expectOk(listExperienceCases('C:/workspace'));

    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      caseId: expect.stringContaining(':mem-1'),
      title: '排查登录超时 2026-08-17',
      problem: '先看请求日志',
      solution: '先看请求日志\n\n- 必须先复现\n- 注意不要扩大改动',
      constraints: ['必须先复现', '注意不要扩大改动'],
      sourceEntryIds: ['mem-1'],
      workspace: 'C:/workspace',
      updatedAt: 2,
    });
  });

  it('保留 user 级经验并过滤其他工作区条目', () => {
    fakeStore.entries = [
      makeEntry({ entryId: 'user-1', scope: 'user', workspace: null, title: '通用排查法' }),
      makeEntry({ entryId: 'ws-1', workspace: 'C:/workspace', title: '当前工作区经验' }),
      makeEntry({ entryId: 'ws-2', workspace: 'D:/other', title: '其他工作区经验' }),
    ];

    const cases = expectOk(listExperienceCases('C:/workspace'));

    expect(cases.map((item) => item.sourceEntryIds[0])).toEqual(['user-1', 'ws-1']);
    expect(cases.map((item) => item.title)).not.toContain('其他工作区经验');
  });
});
