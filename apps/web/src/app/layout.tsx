import type { ReactNode } from 'react';
import { productName } from '@cirne/config/public';

export const metadata = { title: productName, description: 'Ambiente local de desenvolvimento' };
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="pt-BR"><body>{children}</body></html>;
}
