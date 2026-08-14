import type { JSX } from 'react';
import type { MessageKey } from '../shared/i18n-core';
import { useT } from './lib/i18n';

export interface PlanStep {
  step: string;
  status: string;
}

export interface PlanCardProps {
  plan: PlanStep[];
  explanation?: string;
  /** True while the tool call is still running (start event). */
  running?: boolean;
}

const STATUS_MARK: Record<string, string> = {
  completed: '✓',
  in_progress: '▶',
  pending: '○',
};

const STATUS_LABEL_KEY: Record<string, MessageKey> = {
  completed: 'planCard.status.completed',
  in_progress: 'planCard.status.inProgress',
  pending: 'planCard.status.pending',
};

/**
 * Renders an `update_plan` payload as a compact plan card. The harness does
 * not interpret the plan — it is a pass-through display of the model's own
 * plan state machine (codex PlanUpdate style).
 */
export function PlanCard({ plan, explanation, running }: PlanCardProps): JSX.Element {
  const t = useT();
  return (
    <article className="tool-event plan-card">
      <span className="plan-title">{t('planCard.title')}</span>
      {explanation ? <p className="plan-explanation">{explanation}</p> : null}
      <ol className="plan-steps">
        {plan.map((item, index) => {
          const status = item.status;
          const runningStep = Boolean(running) && status === 'in_progress';
          const statusLabel = STATUS_LABEL_KEY[status] ? t(STATUS_LABEL_KEY[status]) : status;
          return (
            <li
              key={`${index}-${item.step}`}
              className={`plan-step plan-step-status-${status}${runningStep ? ' plan-step-status-running' : ''}`}
            >
              <span
                role="img"
                className="plan-step-status"
                aria-label={statusLabel}
                title={statusLabel}
              >
                {STATUS_MARK[status] ?? '·'}
              </span>
              <span className="plan-step-text">{item.step}</span>
            </li>
          );
        })}
      </ol>
    </article>
  );
}
