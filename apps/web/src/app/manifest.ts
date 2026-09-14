import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Cirne Rotas',
    short_name: 'Cirne Rotas',
    description: 'Shell local para operação de campo offline.',
    start_url: '/route',
    display: 'standalone',
    background_color: '#f7f4ec',
    theme_color: '#182b24',
    lang: 'pt-BR',
    icons: [
      { src: '/icons/app-icon.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icons/app-icon-maskable.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  };
}
