import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { productName } from '@cirne/config/public';
import 'leaflet/dist/leaflet.css';
import './styles.css';

export const metadata: Metadata = {
  title: productName,
  description: 'Ambiente local de desenvolvimento',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [{ url: '/icons/app-icon.svg', type: 'image/svg+xml' }],
    shortcut: '/icons/app-icon.svg',
  },
};
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="pt-BR"><body>{children}</body></html>;
}
