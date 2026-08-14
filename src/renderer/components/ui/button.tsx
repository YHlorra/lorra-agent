import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '@/lib/utils';

// Kami 视觉:主按钮 navy 底 / 次按钮 warm beige / 幽灵 navy 描边 / 文字按钮。
// 尺寸与圆角走 Kami 刻度(8px 按钮圆角,34.59px 最小高度)。
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-kami text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-navy text-paper shadow-sm hover:bg-navy/90',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        outline: 'border border-navy/60 bg-transparent text-navy shadow-sm hover:bg-navy/5',
        secondary: 'bg-paper-mid text-ink-secondary shadow-sm hover:bg-paper-mid/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-navy underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-kami px-3 text-xs',
        lg: 'h-10 rounded-kami px-8',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
