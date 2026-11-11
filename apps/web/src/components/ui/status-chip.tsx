import type { HTMLAttributes, ReactNode } from 'react';
import { classNames } from './class-names';

export type StatusTone = 'neutral' | 'success' | 'warning' | 'error' | 'info';

export type StatusChipProps = HTMLAttributes<HTMLSpanElement> & {
  children: ReactNode;
  tone?: StatusTone;
};

export function StatusChip({ children, className, tone = 'neutral', ...props }: StatusChipProps) {
  return <span {...props} className={classNames('cr-status-chip', `cr-status-chip--${tone}`, className)}>
    {children}
  </span>;
}
