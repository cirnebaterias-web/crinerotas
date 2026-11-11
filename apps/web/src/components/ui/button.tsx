import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { classNames } from './class-names';

export type ButtonVariant = 'primary' | 'action' | 'secondary' | 'quiet';
export type ButtonSize = 'standard' | 'field' | 'cta';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  loadingLabel?: string;
  fullWidth?: boolean;
};

export function Button({
  children,
  className,
  variant = 'primary',
  size = 'standard',
  loading = false,
  loadingLabel,
  fullWidth = false,
  disabled,
  type = 'button',
  ...props
}: ButtonProps) {
  return <button
    {...props}
    type={type}
    className={classNames(
      'cr-button',
      `cr-button--${variant}`,
      size !== 'standard' && `cr-button--${size}`,
      fullWidth && 'cr-button--full',
      className,
    )}
    disabled={disabled || loading}
    aria-busy={loading || undefined}
    aria-label={loading && loadingLabel ? loadingLabel : props['aria-label']}
  >{children}</button>;
}
