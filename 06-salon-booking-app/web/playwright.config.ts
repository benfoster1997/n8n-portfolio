import { defineConfig, devices } from '@playwright/test';

// Browser tests run the built app in demo mode (invented data, no Supabase)
// on an iPhone-sized screen.
const chrome = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    ...devices['iPhone 13'],
    browserName: 'chromium',
    launchOptions: { executablePath: chrome },
    timezoneId: 'Europe/London',
    locale: 'en-GB',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'VITE_DEMO=1 npx vite build --outDir dist-demo && npx vite preview --outDir dist-demo --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
