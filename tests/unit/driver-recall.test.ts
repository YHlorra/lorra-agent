import { describe, expect, it, vi } from 'vitest';
import { resolveArchivalRecall } from '../../src/main/memory/archival-resolver';
import {
  buildExperienceContext,
  planExperienceContext,
} from '../../src/main/memory/experience-planner';
import { buildCoreProjection, RECALL_CONTEXT_MARKER } from '../../src/main/memory/recall';
import { planArchivalRecall } from '../../src/main/memory/retrieval-planner';
import { WorkingMemoryStore } from '../../src/main/memory/working-memory';
import { LorraDriver, type SessionPersistence } from '../../src/main/pi-sdk-driver/driver';
import {
  materializeGeneratedSkills,
  readGeneratedSkillAudit,
} from '../../src/main/skills/generated-skill-store';

// 会话启动召回注入挂点(design 6.6):
// send 仅在该会话尚无任何用户消息(新会话/首次发送)时注入记忆块;
// 历史会话已有消息不注入(避免重复污染);召回为空/失败 → 原样发送。
//
// recall 模块整体 mock:注入挂点的职责是「何时拼、拼什么、失败不阻断」,
// 召回内容的组装在 tests/main/recall.test.ts 单独钉死。

vi.mock('../../src/main/memory/recall', () => ({
  RECALL_CONTEXT_MARKER: '<!-- lorra-memory-recall:reference-only -->',
  buildCoreProjection: vi.fn(() => ({
    text: '',
    workspaceIdentity: 'workspace',
    entryIds: [],
  })),
  buildCoreContext: vi.fn(() => ''),
  stripRecallContext: (text: string) => text,
}));

vi.mock('../../src/main/memory/archival-resolver', () => ({
  resolveArchivalRecall: vi.fn(async () => null),
}));

vi.mock('../../src/main/memory/retrieval-planner', () => ({
  planArchivalRecall: vi.fn(() => null),
}));

vi.mock('../../src/main/memory/experience-planner', () => ({
  planExperienceContext: vi.fn(() => null),
  buildExperienceContext: vi.fn(async () => null),
}));

vi.mock('../../src/main/skills/generated-skill-store', () => ({
  materializeGeneratedSkills: vi.fn(() => ({ isErr: () => false, value: [] })),
  readGeneratedSkillAudit: vi.fn(() => null),
}));

function makeHandle(fileEntries: unknown[] = [], messages: unknown[] = []) {
  return {
    sessionId: 'sid',
    sessionManager: { fileEntries },
    messages,
    subscribe: vi.fn(() => () => undefined),
    prompt: vi.fn(async () => {}),
  };
}

function makePersistence(handle: ReturnType<typeof makeHandle>): SessionPersistence {
  return {
    createInMemory: vi.fn().mockResolvedValue(handle),
  } as unknown as SessionPersistence;
}

describe('LorraDriver.send 记忆召回注入(design 6.6)', () => {
  beforeEach(() => {
    vi.spyOn(WorkingMemoryStore.prototype, 'buildContext').mockReturnValue('');
    vi.mocked(buildCoreProjection).mockReset();
    vi.mocked(buildCoreProjection).mockReturnValue({
      text: '',
      workspaceIdentity: 'workspace',
      entryIds: [],
    });
    vi.mocked(resolveArchivalRecall).mockReset();
    vi.mocked(resolveArchivalRecall).mockResolvedValue(null);
    vi.mocked(planArchivalRecall).mockReset();
    vi.mocked(planArchivalRecall).mockReturnValue(null);
    vi.mocked(planExperienceContext).mockReset();
    vi.mocked(planExperienceContext).mockReturnValue(null);
    vi.mocked(buildExperienceContext).mockReset();
    vi.mocked(buildExperienceContext).mockResolvedValue(null);
    vi.mocked(materializeGeneratedSkills).mockReset();
    vi.mocked(materializeGeneratedSkills).mockReturnValue({
      isErr: () => false,
      value: [],
    } as never);
    vi.mocked(readGeneratedSkillAudit).mockReset();
    vi.mocked(readGeneratedSkillAudit).mockReturnValue(null);
  });

  it('新会话首次 send → prompt 文本含 core + recall 记忆块 marker', async () => {
    vi.mocked(buildCoreProjection).mockReturnValue({
      text: '- [workspace_identity] 当前工作区：workspace',
      workspaceIdentity: 'workspace',
      entryIds: ['policy-1'],
    });
    vi.mocked(planArchivalRecall).mockReturnValue({
      reason: '新会话首轮 warm-up recall',
      triggeredBy: 'session-start',
      sources: ['memory'],
    });
    vi.mocked(resolveArchivalRecall).mockResolvedValue({
      reason: '新会话首轮 warm-up recall',
      triggeredBy: 'session-start',
      sources: ['memory'],
      memoryEntryIds: ['recall-1'],
      ofkPaths: [],
      text: '- [working_context] 标题：内容(观察)',
      updatedAt: 1,
    });
    const handle = makeHandle();
    const driver = new LorraDriver({
      workspacePath: 'C:/workspace',
      persistence: makePersistence(handle),
    });
    await driver.newSession();

    await expect(driver.send('sid', '你好')).resolves.toEqual({ accepted: true });

    expect(buildCoreProjection).toHaveBeenCalledWith('C:/workspace');
    expect(planArchivalRecall).toHaveBeenCalledWith('你好', false);
    expect(resolveArchivalRecall).toHaveBeenCalledWith({
      workspace: 'C:/workspace',
      sources: ['memory'],
      triggeredBy: 'session-start',
      reason: '新会话首轮 warm-up recall',
    });
    expect(handle.prompt).toHaveBeenCalledWith(
      `${RECALL_CONTEXT_MARKER}\n## Core Memory\n- [workspace_identity] 当前工作区：workspace\n\n## Archival Recall\n- [working_context] 标题：内容(观察)\n${RECALL_CONTEXT_MARKER}\n\n你好`,
      { streamingBehavior: 'followUp' },
    );
  });

  it('已有消息的历史会话(attach 已 replay 的 fileEntries 含 user 消息)send → 无注入', async () => {
    const handle = makeHandle([
      { type: 'session', id: 'h' },
      {
        type: 'message',
        id: 'm1',
        message: { role: 'user', content: [{ type: 'text', text: '历史' }] },
      },
    ]);
    const driver = new LorraDriver({
      workspacePath: 'C:/workspace',
      persistence: makePersistence(handle),
    });
    await driver.newSession();

    await expect(driver.send('sid', '你好')).resolves.toEqual({ accepted: true });

    expect(buildCoreProjection).toHaveBeenCalledWith('C:/workspace');
    expect(planArchivalRecall).toHaveBeenCalledWith('你好', true);
    expect(resolveArchivalRecall).not.toHaveBeenCalled();
    expect(handle.prompt).toHaveBeenCalledWith('你好', { streamingBehavior: 'followUp' });
  });

  it('会话内已产生用户消息(handle.messages 含 user)的再次 send → 无注入', async () => {
    const handle = makeHandle([], [{ role: 'user', content: [{ type: 'text', text: '上一轮' }] }]);
    const driver = new LorraDriver({
      workspacePath: 'C:/workspace',
      persistence: makePersistence(handle),
    });
    await driver.newSession();

    await expect(driver.send('sid', '你好')).resolves.toEqual({ accepted: true });

    expect(buildCoreProjection).toHaveBeenCalledWith('C:/workspace');
    expect(planArchivalRecall).toHaveBeenCalledWith('你好', true);
    expect(resolveArchivalRecall).not.toHaveBeenCalled();
    expect(handle.prompt).toHaveBeenCalledWith('你好', { streamingBehavior: 'followUp' });
  });

  it('后续轮次仍携带 core block, 但不再附加 recall', async () => {
    vi.mocked(buildCoreProjection).mockReturnValue({
      text: '- [workspace_identity] 当前工作区：workspace',
      workspaceIdentity: 'workspace',
      entryIds: ['policy-1'],
    });
    vi.spyOn(WorkingMemoryStore.prototype, 'buildContext').mockReturnValue(
      '- [goal] 收尾 working memory',
    );
    const handle = makeHandle([], [{ role: 'user', content: [{ type: 'text', text: '上一轮' }] }]);
    const driver = new LorraDriver({
      workspacePath: 'C:/workspace',
      persistence: makePersistence(handle),
    });
    await driver.newSession();

    await expect(driver.send('sid', '继续')).resolves.toEqual({ accepted: true });

    expect(buildCoreProjection).toHaveBeenCalledWith('C:/workspace');
    expect(planArchivalRecall).toHaveBeenCalledWith('继续', true);
    expect(resolveArchivalRecall).not.toHaveBeenCalled();
    expect(handle.prompt).toHaveBeenCalledWith(
      `${RECALL_CONTEXT_MARKER}\n## Core Memory\n- [workspace_identity] 当前工作区：workspace\n\n## Working Memory\n- [goal] 收尾 working memory\n${RECALL_CONTEXT_MARKER}\n\n继续`,
      { streamingBehavior: 'followUp' },
    );
  });

  it('后续轮次命中历史/偏好类问题时 → 追加 query-driven recall', async () => {
    vi.mocked(buildCoreProjection).mockReturnValue({
      text: '- [workspace_identity] 当前工作区：workspace',
      workspaceIdentity: 'workspace',
      entryIds: ['policy-1'],
    });
    vi.mocked(planArchivalRecall).mockReturnValue({
      reason: '用户在追问既有偏好/习惯',
      triggeredBy: 'preference',
      sources: ['memory', 'ofk'],
      query: '你还记得我之前的偏好吗？',
    });
    vi.mocked(resolveArchivalRecall).mockResolvedValue({
      reason: '用户在追问既有偏好/习惯',
      triggeredBy: 'preference',
      sources: ['memory', 'ofk'],
      query: '你还记得我之前的偏好吗？',
      memoryEntryIds: ['pref-1'],
      ofkPaths: ['memory/pref-1.md'],
      text: '- [soft_preference] 偏好：简洁(你明说的)',
      updatedAt: 1,
    });
    const handle = makeHandle([], [{ role: 'user', content: [{ type: 'text', text: '上一轮' }] }]);
    const driver = new LorraDriver({
      workspacePath: 'C:/workspace',
      persistence: makePersistence(handle),
    });
    await driver.newSession();

    await expect(driver.send('sid', '你还记得我之前的偏好吗？')).resolves.toEqual({
      accepted: true,
    });

    expect(resolveArchivalRecall).toHaveBeenCalledWith({
      workspace: 'C:/workspace',
      sources: ['memory', 'ofk'],
      triggeredBy: 'preference',
      reason: '用户在追问既有偏好/习惯',
      query: '你还记得我之前的偏好吗？',
    });
    expect(handle.prompt).toHaveBeenCalledWith(
      `${RECALL_CONTEXT_MARKER}\n## Core Memory\n- [workspace_identity] 当前工作区：workspace\n\n## Archival Recall\n- [soft_preference] 偏好：简洁(你明说的)\n${RECALL_CONTEXT_MARKER}\n\n你还记得我之前的偏好吗？`,
      { streamingBehavior: 'followUp' },
    );
  });

  it('召回为空 → 无注入, 原样发送', async () => {
    vi.mocked(planArchivalRecall).mockReturnValue({
      reason: '新会话首轮 warm-up recall',
      triggeredBy: 'session-start',
      sources: ['memory'],
    });
    const handle = makeHandle();
    const driver = new LorraDriver({
      workspacePath: 'C:/workspace',
      persistence: makePersistence(handle),
    });
    await driver.newSession();

    await expect(driver.send('sid', '你好')).resolves.toEqual({ accepted: true });

    expect(buildCoreProjection).toHaveBeenCalledWith('C:/workspace');
    expect(resolveArchivalRecall).toHaveBeenCalledTimes(1);
    expect(handle.prompt).toHaveBeenCalledWith('你好', { streamingBehavior: 'followUp' });
  });

  it('命中 procedural 问题时，在 archival 后追加 Experience & Skills', async () => {
    vi.mocked(buildCoreProjection).mockReturnValue({
      text: '- [workspace_identity] 当前工作区：workspace',
      workspaceIdentity: 'workspace',
      entryIds: ['policy-1'],
    });
    vi.mocked(planArchivalRecall).mockReturnValue({
      reason: '用户在追问历史决策或既有事实',
      triggeredBy: 'history',
      sources: ['memory'],
      query: '之前怎么修的',
    });
    vi.mocked(resolveArchivalRecall).mockResolvedValue({
      reason: '用户在追问历史决策或既有事实',
      triggeredBy: 'history',
      sources: ['memory'],
      query: '之前怎么修的',
      memoryEntryIds: ['mem-1'],
      ofkPaths: [],
      text: '- [working_context] 之前修过一次',
      updatedAt: 1,
    });
    vi.mocked(planExperienceContext).mockReturnValue({
      reason: '当前问题像可复用的 procedural task，可补经验与技能片段',
      query: '帮我排查登录超时',
    });
    vi.mocked(buildExperienceContext).mockResolvedValue({
      reason: '当前问题像可复用的 procedural task，可补经验与技能片段',
      caseIds: ['case-1'],
      skillNames: ['generated-skill-a'],
      text: '- [case] 排查登录超时：先看请求日志\n- [skill] generated-skill-a：复用步骤',
    });
    const handle = makeHandle();
    const driver = new LorraDriver({
      workspacePath: 'C:/workspace',
      persistence: makePersistence(handle),
    });
    await driver.newSession();

    await expect(driver.send('sid', '帮我排查登录超时')).resolves.toEqual({ accepted: true });

    expect(planExperienceContext).toHaveBeenCalledWith('帮我排查登录超时');
    expect(buildExperienceContext).toHaveBeenCalledWith('C:/workspace', {
      reason: '当前问题像可复用的 procedural task，可补经验与技能片段',
      query: '帮我排查登录超时',
    });
    expect(handle.prompt).toHaveBeenCalledWith(
      `${RECALL_CONTEXT_MARKER}\n## Core Memory\n- [workspace_identity] 当前工作区：workspace\n\n## Archival Recall\n- [working_context] 之前修过一次\n\n## Experience & Skills\n- [case] 排查登录超时：先看请求日志\n- [skill] generated-skill-a：复用步骤\n${RECALL_CONTEXT_MARKER}\n\n帮我排查登录超时`,
      { streamingBehavior: 'followUp' },
    );
  });

  it('getExperienceAudit 会懒生成 generated skills 后回读 provenance', async () => {
    const handle = makeHandle();
    const driver = new LorraDriver({
      workspacePath: 'C:/workspace',
      persistence: makePersistence(handle),
    });
    vi.mocked(readGeneratedSkillAudit).mockReturnValue({
      skillName: 'generated-skill-a',
      generated: true,
      filePath: 'C:/workspace/.lorra/skills/generated/generated-skill-a/SKILL.md',
      caseIds: ['case-1'],
      entryIds: ['mem-1'],
      warnings: [],
    });

    const audit = await driver.getExperienceAudit('排查登录超时');

    expect(materializeGeneratedSkills).toHaveBeenCalledWith('C:/workspace');
    expect(readGeneratedSkillAudit).toHaveBeenCalledWith('C:/workspace', '排查登录超时');
    expect(audit?.skillName).toBe('generated-skill-a');
  });

  it('注入失败(召回抛错) → 原样发送, 不影响会话', async () => {
    vi.mocked(planArchivalRecall).mockReturnValue({
      reason: '新会话首轮 warm-up recall',
      triggeredBy: 'session-start',
      sources: ['memory'],
    });
    vi.mocked(resolveArchivalRecall).mockRejectedValue(new Error('recall boom'));
    const handle = makeHandle();
    const driver = new LorraDriver({
      workspacePath: 'C:/workspace',
      persistence: makePersistence(handle),
    });
    await driver.newSession();

    await expect(driver.send('sid', '你好')).resolves.toEqual({ accepted: true });
    expect(buildCoreProjection).toHaveBeenCalledWith('C:/workspace');
    expect(handle.prompt).toHaveBeenCalledWith('你好', { streamingBehavior: 'followUp' });
  });
});
