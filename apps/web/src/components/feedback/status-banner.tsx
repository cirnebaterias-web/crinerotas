import type { HTMLAttributes, ReactNode } from 'react';
import { classNames } from '../ui/class-names';

export type StatusBannerTone = 'info' | 'success' | 'warning' | 'error';

const defaultTitles: Record<StatusBannerTone, string> = {
  info: 'Informacao',
  success: 'Concluido',
  warning: 'Atencao',
  error: 'Erro',
};

export type StatusBannerProps = Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  children: ReactNode;
  tone?: StatusBannerTone;
  title?: ReactNode;
};

export function StatusBanner({
  children,
  className,
  tone = 'info',
  title,
  role,
  ...props
}: StatusBannerProps) {
  return <div
    {...props}
    className={classNames('cr-status-banner', `cr-status-banner--${tone}`, className)}
    role={role ?? (tone === 'error' ? 'alert' : 'status')}
  >
    <span className="cr-status-banner__marker" aria-hidden="true" />
    <div className="cr-status-banner__content">
      <strong className="cr-status-banner__title">{title ?? defaultTitles[tone]}</strong>
      <div>{children}</div>
    </div>
  </div>;
}
