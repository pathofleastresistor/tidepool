import { defineConfig } from 'vitest/config'

// Unit tests sit next to the code they test. Only this checkout's src: worktrees under .claude
// have their own.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'] }
})
