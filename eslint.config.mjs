import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: [
    '**/node_modules/**',
    '**/.next/**',
    '**/next-env.d.ts',
    'apps/web/public/sw.js',
    'apps/web/public/sw.js.map',
    'apps/web/public/worker-*.js',
    'apps/web/public/worker-*.js.map',
  ] },
  ...tseslint.configs.recommended,
  { files: ['apps/web/src/app/**/*.tsx'], rules: {
    'no-restricted-imports': ['error', { patterns: ['@cirne/config/server', '**/server/*', '@/server/*'] }],
  } },
);
