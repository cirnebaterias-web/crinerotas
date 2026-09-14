import type { ReactNode } from 'react';
import { productName } from '@cirne/config/public';
import './styles.css';

export const metadata = {
  title: productName,
  description: 'Ambiente local de desenvolvimento',
  manifest: '/manifest.webmanifest',
};
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="pt-BR"><body>{children}</body></html>;
}
