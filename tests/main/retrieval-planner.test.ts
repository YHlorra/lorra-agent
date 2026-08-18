import { describe, expect, it } from 'vitest';
import { planArchivalRecall } from '../../src/main/memory/retrieval-planner';

describe('planArchivalRecall', () => {
  it('新会话保留 warm-up recall', () => {
    expect(planArchivalRecall('你好', false)).toEqual({
      reason: '新会话首轮 warm-up recall',
      triggeredBy: 'session-start',
      sources: ['memory'],
    });
  });

  it('后续轮次命中偏好类问题时触发 query-driven recall', () => {
    expect(planArchivalRecall('你还记得我之前的偏好吗？', true)).toEqual({
      reason: '用户在追问既有偏好/习惯',
      triggeredBy: 'preference',
      sources: ['memory', 'ofk'],
      query: '你还记得我之前的偏好吗？',
    });
  });

  it('后续轮次命中工作区约束时触发 query-driven recall', () => {
    expect(planArchivalRecall('这个仓库现在还有哪些硬规则？', true)).toEqual({
      reason: '问题依赖工作区规则或项目上下文',
      triggeredBy: 'workspace',
      sources: ['memory', 'ofk'],
      query: '这个仓库现在还有哪些硬规则？',
    });
  });

  it('普通继续性消息不触发 archival recall', () => {
    expect(planArchivalRecall('继续改吧', true)).toBeNull();
  });
});
