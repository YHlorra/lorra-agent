import type {
  AgentSession,
  CreateAgentSessionFromServicesOptions,
} from '@earendil-works/pi-coding-agent';
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { LorraError } from '../../shared/result';
import { err, ok } from '../../shared/result';
import { tMain } from '../i18n';
import { lorraConfigDir } from '../pi-sdk-driver/lorra-config-dir';
import { readSettings } from '../workspace/settings';
import type { ModelInvoke } from './review-generator';

/**
 * 生产 ModelInvoke 接线:复用 pi-sdk driver/session 基建(design D8「冷会话
 * 清洗复用 SessionManager,不建运行时」的思想延伸),起一个不进用户界面的
 * 隐藏内存会话跑生成:
 * - createAgentSessionServices 复用既有模型配置(ModelConfigAdapter),不绕过
 * 用户已配置的模型提供方
 * - SessionManager.inMemory:零落盘,不污染会话目录,不产生事实
 * - tools: [] 禁用全部工具,只取模型文本输出
 * - 无可用模型/认证缺失 → Err code 'model-unavailable'(前端按此 code 禁入口)
 * - 生成超时(120s)中止会话,防挂死
 */
export const REVIEW_GENERATION_TIMEOUT_MS = 120_000;

/**
 * 错误归类(纯函数):
 * - 超时先判(timed out / Timeout exceeded / ETIMEDOUT)→ 'review-timed-out',
 * message 含「超时」与「重试」指引
 * - 无模型/认证(No API key found / Authentication failed / no model / login /
 * credentials)→ 'model-unavailable'(前端按此 code 禁入口)
 * - 其他(含非 Error 输入)→ 'review-generation-failed'
 */
export function mapReviewError(err: unknown): LorraError {
  const message = err instanceof Error ? err.message : String(err);
  if (/timed out|timeout exceeded|etimedout/i.test(message)) {
    return {
      code: 'review-timed-out',
      message: tMain('errors.review.timeout', { seconds: REVIEW_GENERATION_TIMEOUT_MS / 1000 }),
    };
  }
  if (/no model|no api key|authentication failed|login|credentials/i.test(message)) {
    return { code: 'model-unavailable', message };
  }
  return { code: 'review-generation-failed', message };
}

export function createCompileModelInvoke(): ModelInvoke {
  return async (prompt) => {
    let session: AgentSession | undefined;
    try {
      const cwd = process.cwd();
      const services = await createAgentSessionServices({
        cwd,
        agentDir: lorraConfigDir(),
      });
      // 语义清洗专用模型:settings.compileModel 已配置 → 经
      // services.modelRuntime.getModel 解析并传入会话(不传则走默认模型);
      // getModel 失败/读设置失败 → console.warn 走默认,不阻断编译。
      let compileModel: NonNullable<CreateAgentSessionFromServicesOptions['model']> | undefined;
      try {
        const settings = await readSettings();
        if (settings.compileModel) {
          const resolved = services.modelRuntime.getModel(
            settings.compileModel.providerId,
            settings.compileModel.modelId,
          );
          if (resolved) {
            compileModel = resolved;
          } else {
            console.warn(
              `[compile-model] model not found: ${settings.compileModel.providerId}/${settings.compileModel.modelId}; using default`,
            );
          }
        }
      } catch (cause) {
        console.warn('[compile-model] settings unavailable; using default model:', cause);
      }
      const sessionManager = SessionManager.inMemory(cwd);
      const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        tools: [],
        ...(compileModel ? { model: compileModel } : {}),
      });
      session = created.session;

      if (!session.model) {
        return err({ code: 'model-unavailable', message: tMain('errors.review.noModel') });
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('review generation timed out'));
        }, REVIEW_GENERATION_TIMEOUT_MS);
        timer.unref?.();
      });
      try {
        await Promise.race([session.prompt(prompt, { expandPromptTemplates: false }), timeout]);
      } catch (cause) {
        try {
          await session.abort();
        } catch {
          // abort 失败不掩盖原始错误
        }
        throw cause;
      } finally {
        // prompt 正常完成或失败都清掉超时定时器(不再只靠 unref 兜底)。
        if (timer !== undefined) clearTimeout(timer);
      }

      const answer = lastAssistantText(
        (
          session.sessionManager as unknown as {
            fileEntries: Array<{ type?: string; message?: { role?: string; content?: unknown } }>;
          }
        ).fileEntries,
      );
      if (!answer) {
        return err({
          code: 'review-generation-failed',
          message: tMain('errors.review.emptyResponse'),
        });
      }
      return ok(answer);
    } catch (cause) {
      return err(mapReviewError(cause));
    } finally {
      try {
        session?.dispose();
      } catch {
        // dispose 失败无需再处理
      }
    }
  };
}

/** 从内存会话的条目中取最后一条 assistant 消息文本。 */
function lastAssistantText(
  fileEntries: Array<{ type?: string; message?: { role?: string; content?: unknown } }>,
): string {
  for (let i = fileEntries.length - 1; i >= 0; i--) {
    const entry = fileEntries[i];
    if (entry.type === 'message' && entry.message?.role === 'assistant') {
      const text = extractText(entry.message.content);
      if (text) return text;
    }
  }
  return '';
}

/** 从消息 content 提取纯文本(text 块数组 / 字符串 / {type:text})。 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === 'object') {
          const record = block as { type?: unknown; text?: unknown };
          if (record.type === 'text' && typeof record.text === 'string') return record.text;
        }
        return '';
      })
      .join('\n')
      .trim();
  }
  if (content && typeof content === 'object') {
    const record = content as { type?: unknown; text?: unknown };
    if (record.type === 'text' && typeof record.text === 'string') return record.text;
  }
  return '';
}
