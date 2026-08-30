import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // These pages intentionally kick off async fetch/polling functions from effects.
      // The actual state updates happen after awaited network I/O, not synchronously in the effect body.
      'react-hooks/set-state-in-effect': 'off',
      // Keep CI focused on correctness; unused imports/state are cleanup items, not build blockers.
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  globalIgnores(['.next/**', 'node_modules/**', 'coverage/**', 'data/**', 'vpn_configs/**']),
]);
