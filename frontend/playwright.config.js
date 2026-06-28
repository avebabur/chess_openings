import { defineConfig, devices } from '@playwright/test'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

const port = 8011
const dbPath = resolve(tmpdir(), `chess-openings-e2e-${Date.now()}.db`)

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `npm run build && cd .. && CHESS_DB_PATH=${dbPath} CHESS_OPENINGS_DESKTOP=1 OPENINGS_DISABLE_EXTERNAL_NETWORK=1 venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
