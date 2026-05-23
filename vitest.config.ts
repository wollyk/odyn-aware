// Vitest config — separate from vite.config.ts so the production build
// isn't burdened with test-only plugins. Inherits path aliases from
// vite-tsconfig-paths so `@/foo` imports work in tests too.

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["node_modules", "dist", "server/**", "tests/e2e/**"],
    css: false,
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/features/live/**", "src/lib/**"],
    },
  },
});
