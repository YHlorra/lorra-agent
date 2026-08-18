import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * shadcn 风格 Badge 封装（2026-08-18，组件库路线）：
 * 样式锚 styles.css 既有 .sk-b* 规则（Kami token），variant 映射既有徽章型：
 * default=panel 中性 / inner=内部·未注入 / dupe=副本 / issue=问题浅红 /
 * gitBehind=有更新 accent / gitDirty=已修改 warm-brown / scope=作用域 / source=来源。
 */
const badgeVariants = cva('sk-b', {
  variants: {
    variant: {
      default: 'sk-b-inner',
      inner: 'sk-b-inner',
      dupe: 'sk-b-dupe',
      issue: 'sk-b-issue',
      gitBehind: 'sk-b-git-behind',
      gitDirty: 'sk-b-git-dirty',
      scope: 'sk-b-scope',
      source: 'sk-b-src',
    },
  },
  defaultVariants: { variant: 'default' },
});

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
