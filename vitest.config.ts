import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts', 'src/llm/client.ts'],
      thresholds: {
        lines: 90,
        functions: 95,
        branches: 80,
        statements: 90,
      },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});