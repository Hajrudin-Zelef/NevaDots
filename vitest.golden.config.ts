import { defineConfig } from 'vitest/config';

/**
 * Configuration dédiée aux questions d'or : appels réels au corpus et au
 * modèle, jamais lancés par `npm test`.
 */
export default defineConfig({
  test: {
    include: ['tests/golden/**/*.golden.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
