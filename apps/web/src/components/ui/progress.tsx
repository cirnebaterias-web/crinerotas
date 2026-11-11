import type { HTMLAttributes } from 'react';
import { classNames } from './class-names';

export type ProgressProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  value: number;
  max?: number;
  label: string;
  showValue?: boolean;
  formatValue?: (value: number, max: number) => string;
};

export function Progress({
  value,
  max = 100,
  label,
  showValue = true,
  formatValue = (current, total) => `${Math.round((current / total) * 100)}%`,
  className,
  ...props
}: ProgressProps) {
  const safeMax = max > 0 ? max : 100;
  const safeValue = Math.min(Math.max(value, 0), safeMax);

  return <div {...props} className={classNames('cr-progress', className)}>
    <div className="cr-progress__header">
      <span className="cr-progress__label">{label}</span>
      {showValue && <span className="cr-progress__value" aria-hidden="true">{formatValue(safeValue, safeMax)}</span>}
    </div>
    <progress value={safeValue} max={safeMax} aria-label={label} />
  </div>;
}
