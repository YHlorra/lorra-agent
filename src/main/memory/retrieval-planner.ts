import type { ArchivalTrigger } from '../../shared/memory-api';

export interface RetrievalPlan {
  query?: string;
  reason: string;
  triggeredBy: ArchivalTrigger;
  sources: Array<'memory' | 'ofk'>;
}

const HISTORY_TRIGGER =
  /之前|刚才|上次|前面|记得|说过|讨论过|决定|结论|历史|恢复|续接|接着|刚才做到哪|remember|earlier|before|resume/i;
const PREFERENCE_TRIGGER = /偏好|习惯|喜欢|不喜欢|风格|要求|preference|prefer/i;
const WORKSPACE_TRIGGER =
  /工作区|仓库|代码库|repo|项目约束|规则|规范|技术栈|限制|约束|policy|constraint/i;
const CORRECTION_TRIGGER = /纠正|更正|不是|改成|改为|修正|correction|instead/i;
const RESUME_TRIGGER = /续接|恢复|接着|继续之前|上次做到哪|resume|pick up/i;

/**
 * P3 首版检索规划:只保留少量高价值触发词,命中时把整条用户文本当 query 传给 recall。
 * ponytail: 先用宿主侧确定性规则兜底; 误判明显时再升级成分类器/多源检索。
 */
export function planArchivalRecall(text: string, hasUserMessages: boolean): RetrievalPlan | null {
  const query = text.trim();
  if (query === '') return null;
  if (!hasUserMessages) {
    return {
      reason: '新会话首轮 warm-up recall',
      triggeredBy: 'session-start',
      sources: ['memory'],
    };
  }
  if (PREFERENCE_TRIGGER.test(query)) {
    return {
      reason: '用户在追问既有偏好/习惯',
      triggeredBy: 'preference',
      sources: ['memory', 'ofk'],
      query,
    };
  }
  if (WORKSPACE_TRIGGER.test(query)) {
    return {
      reason: '问题依赖工作区规则或项目上下文',
      triggeredBy: 'workspace',
      sources: ['memory', 'ofk'],
      query,
    };
  }
  if (CORRECTION_TRIGGER.test(query)) {
    return {
      reason: '用户在纠正既有结论，需要翻旧账',
      triggeredBy: 'correction',
      sources: ['memory', 'ofk'],
      query,
    };
  }
  if (RESUME_TRIGGER.test(query)) {
    return {
      reason: '用户在恢复或续接历史上下文',
      triggeredBy: 'resume',
      sources: ['memory', 'ofk'],
      query,
    };
  }
  if (HISTORY_TRIGGER.test(query)) {
    return {
      reason: '用户在追问历史决策或既有事实',
      triggeredBy: 'history',
      sources: ['memory', 'ofk'],
      query,
    };
  }
  return null;
}
