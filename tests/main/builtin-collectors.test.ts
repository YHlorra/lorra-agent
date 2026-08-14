import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBuiltinCollectors } from '../../src/main/ofk/builtin-collectors';
import { createClaudeCodeCollector } from '../../src/main/ofk/builtin-collectors/claude-code';
import { createOhMyPiCollector } from '../../src/main/ofk/builtin-collectors/oh-my-pi';
import { createOpencodeCollector } from '../../src/main/ofk/builtin-collectors/opencode';
import { createWorkbuddyCollector } from '../../src/main/ofk/builtin-collectors/workbuddy';

// Requirement(step 4):claude-code 适配器从 ~/.claude/projects 下的
// jsonl 合成 PluginFact(title=首条 user ≤60 / activeMs=首末差 / tools 去重);
// 目录缺失 → Ok([]) fail-open。真实会话格式以样本校准(当前按 Assumptions 格式)。

/** Claude Code 风格 jsonl(无 session 头;type=user|assistant,content 文本或块数组)。 */
const CLAUDE_SAMPLE = [
  {
    type: 'user',
    message: { role: 'user', content: 'Fix the flaky login test' },
    timestamp: '2026-08-08T01:00:00.000Z',
  },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me look.' },
        { type: 'tool_use', id: 't1', name: 'read', input: { file_path: 'x' } },
        { type: 'tool_use', id: 't2', name: 'write', input: { file_path: 'x' } },
      ],
    },
    timestamp: '2026-08-08T01:01:00.000Z',
  },
  {
    type: 'assistant',
    message: { role: 'assistant', content: 'Found and fixed it.' },
    timestamp: '2026-08-08T01:02:30.000Z',
  },
]
  .map((l) => JSON.stringify(l))
  .join('\n');

describe('builtin-collectors', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lorra-claude-home-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  it('claude-code: 扫描 ~/.claude/projects 下 jsonl → 合成事实(字段契约)', async () => {
    const projectDir = path.join(home, '.claude', 'projects', 'E--work-demo');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(projectDir, '20260808_abc123.jsonl'), CLAUDE_SAMPLE, 'utf8');

    const collector = createClaudeCodeCollector();
    const result = await collector.collect();
    expect(result.isOk()).toBe(true);
    const facts = result.unwrapOr([]);
    expect(facts).toHaveLength(1);

    const fact = facts[0];
    expect(fact.sessionRef).toBe('claude-code-20260808_abc123');
    expect(fact.collector).toBe('claude-code');
    expect(fact.title).toBe('Fix the flaky login test');
    expect(fact.workspace).toBe('E--work-demo');
    // activeMs = 首末 timestamp 差(1:00 → 1:02:30 = 150s)
    expect(fact.start).toBe(Date.parse('2026-08-08T01:00:00.000Z'));
    expect(fact.end).toBe(Date.parse('2026-08-08T01:02:30.000Z'));
    expect(fact.activeMs).toBe(150_000);
    expect(fact.tokens).toBe(0);
    expect(fact.tools).toEqual(['read', 'write']); // tool_use 名去重保序
    expect(fact.unfinished).toBe(false);
  });

  it('目录缺失 → Ok([]) fail-open', async () => {
    const collector = createClaudeCodeCollector();
    const result = await collector.collect();
    expect(result.isOk()).toBe(true);
    expect(result.unwrapOr([])).toEqual([]);
  });

  it('坏行/缺行跳过;空文件 → Ok([])', async () => {
    const projectDir = path.join(home, '.claude', 'projects', 'ws');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(projectDir, 'garbage.jsonl'), 'not-json\n{"type":"user"}\n', 'utf8');
    writeFileSync(path.join(projectDir, 'empty.jsonl'), '', 'utf8');

    const collector = createClaudeCodeCollector();
    const result = await collector.collect();
    expect(result.isOk()).toBe(true);
    expect(result.unwrapOr([])).toEqual([]);
  });

  it('createBuiltinCollectors: 按 dataSources 开关过滤(pi 恒开不在此列)', async () => {
    const enabled = createBuiltinCollectors({ claudeCode: true });
    expect(enabled.map((c) => c.name)).toEqual(['claude-code']);
    const none = createBuiltinCollectors({});
    expect(none).toEqual([]);
    const all = createBuiltinCollectors({
      claudeCode: true,
      opencode: true,
      ohMyPi: true,
      workbuddy: true,
    });
    expect(all.map((c) => c.name).sort()).toEqual([
      'claude-code',
      'oh-my-pi',
      'opencode',
      'workbuddy',
    ]);
  });

  it('oh-my-pi: 扫描 ~/.omp/agent/sessions 下 pi 格式 jsonl → 合成事实(workspace=头 cwd)', async () => {
    // 真实 Oh My Pi(pi CLI)会话格式:type:"session" 头(含真实 cwd)+ type:"message" 行
    const piSample = [
      {
        type: 'session',
        version: 3,
        id: '019f953c-95ee-72d1-bbbf-9421c5afcfc1',
        timestamp: '2026-08-08T01:00:00.000Z',
        cwd: 'E:\\work\\demo',
      },
      {
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: '2026-08-08T01:00:05.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '安装 pi-extension 扩展' }],
        },
      },
      {
        type: 'message',
        id: 'm2',
        parentId: 'm1',
        timestamp: '2026-08-08T01:02:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '好的' },
            { type: 'tool_use', id: 't1', name: 'read', input: {} },
          ],
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n');

    const sessionDir = path.join(home, '.omp', 'agent', 'sessions', '--E--work-demo--');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(path.join(sessionDir, '20260808_abc123.jsonl'), piSample, 'utf8');
    // 嵌套任务子会话(同会话目录下的 T*.jsonl 子转录):必须排除,避免时间线碎片
    const taskDir = path.join(sessionDir, '20260808_abc123');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(path.join(taskDir, 'T1Port.jsonl'), piSample, 'utf8');

    const collector = createOhMyPiCollector();
    const result = await collector.collect();
    expect(result.isOk()).toBe(true);
    const facts = result.unwrapOr([]);
    expect(facts).toHaveLength(1); // 嵌套任务文件被排除
    const fact = facts[0];
    expect(fact.collector).toBe('oh-my-pi');
    expect(fact.sessionRef).toBe('oh-my-pi-20260808_abc123');
    expect(fact.title).toBe('安装 pi-extension 扩展');
    expect(fact.workspace).toBe('E:\\work\\demo'); // 真实 cwd(非 slug)
    expect(fact.activeMs).toBe(120_000);
    expect(fact.tools).toEqual(['read']);
  });

  it('claude-code: 无 session 头但行带顶层 cwd → workspace=真实 cwd(非 slug)', async () => {
    // 真实 claude-code 新格式:无 type:'session' 头,user/assistant/file-history-snapshot
    // 行都带顶层 cwd;headerCwd 兜底应放宽到任意行顶层 cwd。
    const cwdSample = [
      { type: 'last-prompt', leafUuid: 'u1', sessionId: 's1' },
      {
        type: 'user',
        message: { role: 'user', content: '重构会话收集器' },
        timestamp: '2026-08-08T02:00:00.000Z',
        cwd: 'E:\\work\\demo',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: '完成' },
        timestamp: '2026-08-08T02:01:00.000Z',
        cwd: 'E:\\work\\demo',
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n');
    const projectDir = path.join(home, '.claude', 'projects', 'E--work-demo');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(projectDir, '20260808_cwd.jsonl'), cwdSample, 'utf8');

    const collector = createClaudeCodeCollector();
    const result = await collector.collect();
    expect(result.isOk()).toBe(true);
    const facts = result.unwrapOr([]);
    expect(facts).toHaveLength(1);
    expect(facts[0].workspace).toBe('E:\\work\\demo'); // 真实 cwd,不再用 slug
    expect(facts[0].title).toBe('重构会话收集器');
  });

  it('workbuddy: 顶层 role/content 布局 → title=ai-title、workspace=cwd、tools=function_call', async () => {
    // 真实 WorkBuddy 格式:type:'message' + 顶层 role/content(块 type='input_text'),
    // ai-title 行带真实标题,function_call 行顶层 name 即工具名,每行都带顶层 cwd。
    const wbSample = [
      {
        type: 'ai-title',
        timestamp: 1783000000000,
        aiTitle: '修复登录测试',
        sessionId: 's1',
        cwd: 'E:\\work\\demo',
      },
      {
        type: 'message',
        id: 'm1',
        timestamp: 1783000001000,
        role: 'user',
        content: [{ type: 'input_text', text: '帮我看看登录测试为什么挂' }],
        sessionId: 's1',
        cwd: 'E:\\work\\demo',
      },
      {
        type: 'message',
        id: 'm2',
        timestamp: 1783000002000,
        role: 'assistant',
        content: [{ type: 'text', text: '好的' }],
        sessionId: 's1',
        cwd: 'E:\\work\\demo',
      },
      {
        type: 'function_call',
        id: 'f1',
        timestamp: 1783000003000,
        name: 'Bash',
        arguments: '{"command":"npm test"}',
        sessionId: 's1',
        cwd: 'E:\\work\\demo',
      },
      {
        type: 'function_call_result',
        id: 'r1',
        timestamp: 1783000004000,
        name: 'Bash',
        output: 'ok',
        sessionId: 's1',
        cwd: 'E:\\work\\demo',
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n');
    const sessionDir = path.join(home, '.workbuddy', 'projects', 'E--work-demo');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(path.join(sessionDir, '20260808_wb.jsonl'), wbSample, 'utf8');

    const collector = createWorkbuddyCollector();
    const result = await collector.collect();
    expect(result.isOk()).toBe(true);
    const facts = result.unwrapOr([]);
    expect(facts).toHaveLength(1);
    const fact = facts[0];
    expect(fact.sessionRef).toBe('workbuddy-20260808_wb');
    expect(fact.title).toBe('修复登录测试'); // ai-title 优先于首条 user 文本
    expect(fact.workspace).toBe('E:\\work\\demo'); // 顶层 cwd(非 slug)
    expect(fact.tools).toEqual(['Bash']); // function_call 顶层 name 收集
    expect(fact.start).toBe(1783000000000);
    expect(fact.end).toBe(1783000004000);
    expect(fact.activeMs).toBe(4_000);
  });

  it('workbuddy: 扫描收窄到 projects/(audit-log 形态不被收集)+ 嵌套子转录排除', async () => {
    // audit-log 是命令安全审计事件(有 timestamp 无 type/role):若全扫会产出垃圾事实,
    // root 限定 ~/.workbuddy/projects 后不再被收集。
    const auditLog = [
      {
        category: 'command-safety',
        eventType: 'command-safety.sandbox-executed',
        timestamp: 1783000000000,
      },
      {
        category: 'command-safety',
        eventType: 'command-safety.approved',
        timestamp: 1783000010000,
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n');
    const auditDir = path.join(home, '.workbuddy', 'audit-log');
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(path.join(auditDir, '2026-08-13.jsonl'), auditLog, 'utf8');

    // projects 下正常会话 + 嵌套子转录(应被 maxDepth=2 排除)
    const sessionDir = path.join(home, '.workbuddy', 'projects', 'E--work-demo');
    mkdirSync(sessionDir, { recursive: true });
    const goodSample = [
      {
        type: 'message',
        id: 'm1',
        timestamp: 1783000001000,
        role: 'user',
        content: [{ type: 'input_text', text: '正常会话' }],
        sessionId: 's1',
        cwd: 'E:\\work\\demo',
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n');
    writeFileSync(path.join(sessionDir, '20260808_wb.jsonl'), goodSample, 'utf8');
    const taskDir = path.join(sessionDir, '20260808_wb');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(path.join(taskDir, 'T1.jsonl'), goodSample, 'utf8');

    const collector = createWorkbuddyCollector();
    const result = await collector.collect();
    expect(result.isOk()).toBe(true);
    const facts = result.unwrapOr([]);
    // 只有 projects 下的顶层会话;audit-log 与嵌套子转录均不产出
    expect(facts).toHaveLength(1);
    expect(facts[0].workspace).toBe('E:\\work\\demo');
  });

  it('opencode: 从 ~/.local/share/opencode/opencode.db 读 session 表 → 字段映射', async () => {
    const ocDir = path.join(home, '.local', 'share', 'opencode');
    mkdirSync(ocDir, { recursive: true });
    const db = new DatabaseSync(path.join(ocDir, 'opencode.db'));
    db.exec(`CREATE TABLE session (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      parent_id text,
      slug text NOT NULL,
      directory text NOT NULL,
      title text NOT NULL,
      version text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      tokens_input integer,
      tokens_output integer,
      tokens_reasoning integer,
      model text
    )`);
    const insert = db.prepare(
      `INSERT INTO session
        (id, project_id, slug, directory, title, version, time_created, time_updated,
         tokens_input, tokens_output, tokens_reasoning, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      'ses_abc',
      'global',
      'calm-planet',
      'E:/work/demo',
      '重构会话收集器',
      '1.14.28',
      1783000000000,
      1783000090000,
      100,
      200,
      50,
      JSON.stringify({ id: 'deepseek-v4-flash', providerID: 'opencode-go', variant: 'max' }),
    );
    db.close();

    const collector = createOpencodeCollector();
    const result = await collector.collect();
    expect(result.isOk()).toBe(true);
    const facts = result.unwrapOr([]);
    expect(facts).toHaveLength(1);
    const fact = facts[0];
    expect(fact.collector).toBe('opencode');
    expect(fact.sessionRef).toBe('opencode-ses_abc');
    // directory 正斜杠 → 本机分隔符(与 pi 链路口径一致,避免分组分裂)
    expect(fact.workspace).toBe(path.join('E:', 'work', 'demo'));
    expect(fact.title).toBe('重构会话收集器');
    expect(fact.start).toBe(1783000000000);
    expect(fact.end).toBe(1783000090000);
    expect(fact.activeMs).toBe(90_000);
    expect(fact.tokens).toBe(350); // input+output+reasoning
    expect(fact.model).toBe('deepseek-v4-flash'); // JSON 串取 id 字段
    expect(fact.tools).toEqual([]); // 取舍:不读 message/part 全量
  });

  it('opencode: db 缺失 → Ok([]) fail-open', async () => {
    const collector = createOpencodeCollector();
    const result = await collector.collect();
    expect(result.isOk()).toBe(true);
    expect(result.unwrapOr([])).toEqual([]);
  });
});
