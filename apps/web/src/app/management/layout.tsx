import type { ReactNode } from 'react';
import { ManagementLayout } from '@/features/management/management-layout';

export default function Layout({ children }: { children: ReactNode }) {
  return <ManagementLayout>{children}</ManagementLayout>;
}
