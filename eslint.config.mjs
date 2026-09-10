import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/.next/**', '**/next-env.d.ts'] },
  ...tseslint.configs.recommended,
  { files: ['apps/web/src/app/**/*.tsx'], rules: {
    'no-restricted-imports': ['error', { patterns: ['@cirne/config/server', '**/server/*', '@/server/*'] }],
  } },
);
