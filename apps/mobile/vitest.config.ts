import { defineConfig } from 'vitest/config';

/**
 * Extra Vitest config for the mobile app, merged in by the Angular unit-test
 * builder via the `runnerConfig` option.
 *
 * Ionic ships FESM bundles that use directory imports (e.g.
 * `@ionic/core/components`) which Vitest's Node ESM resolution rejects with
 * "Directory import ... is not supported". Inlining the Ionic packages makes
 * Vite transform them instead, which resolves those imports correctly.
 */
export default defineConfig({
  test: {
    server: {
      deps: {
        inline: [/@ionic\//, /ionicons/, /@stencil\//],
      },
    },
  },
});
