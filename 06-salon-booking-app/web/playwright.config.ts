import { defineConfig, devices } from '@playwright/test';

// Browser tests run the built app in demo mode (invented data, no Supabase)
// on an iPhone-sized screen. E2E_PORT lets two runs share a machine.
const chrome = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const port = Number(process.env.E2E_PORT || 4173);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    ...devices['iPhone 13'],
    browserName: 'chromium',
    launchOptions: { executablePath: chrome },
    timezoneId: 'Europe/London',
    locale: 'en-GB',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `VITE_DEMO=1 npx vite build --outDir dist-demo-${port} && npx vite preview --outDir dist-demo-${port} --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
