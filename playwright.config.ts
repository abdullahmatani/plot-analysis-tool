import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PAT_PORT ?? 4173);

/**
 * E2E suites. Every test runs through the zero-egress fixture (e2e/fixtures.ts): any request to a
 * host other than the app's origin fails the test (rows 7, 88; NFR-8).
 * Primary browsers: Chromium (and Edge when installed, PAT_EDGE=1). Secondary: Firefox and WebKit
 * run the @smoke subset (PAT_SECONDARY=1) — row 83.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    // Each test starts with a fresh profile, so the service worker would precache the whole app
    // during the test and announce "Ready to work offline" at an unpredictable moment, moving the
    // toast stack over the controls being clicked. Tests of the PWA itself opt in (offline.spec.ts;
    // the fault-injection and performance suites use their own persistent profiles).
    serviceWorkers: 'block',
  },
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /(kill|perf)\.spec/ },
    ...(process.env.PAT_EDGE
      ? [
          {
            name: 'msedge',
            use: { ...devices['Desktop Edge'], channel: 'msedge' },
            testIgnore: /(kill|perf)\.spec/,
          },
        ]
      : []),
    ...(process.env.PAT_SECONDARY
      ? [
          { name: 'firefox', use: { ...devices['Desktop Firefox'] }, grep: /@smoke/ },
          { name: 'webkit', use: { ...devices['Desktop Safari'] }, grep: /@smoke/ },
        ]
      : []),
    // Performance budget (row 82): `npm run e2e:perf`; on the reference machine `npm run perf:reference`,
    // which enforces the FDR budgets (PAT_PERF_STRICT=1) in a visible window so WebGL uses the GPU
    // (PAT_HEADED=1; headless browsers usually render in software), optionally in the installed
    // Edge or Chrome (PAT_CHANNEL=msedge|chrome).
    {
      name: 'perf',
      testMatch: /perf\.spec/,
      use: {
        ...devices['Desktop Chrome'],
        headless: !process.env.PAT_HEADED,
        ...(process.env.PAT_CHANNEL ? { channel: process.env.PAT_CHANNEL } : {}),
      },
      timeout: 10 * 60_000,
    },
    { name: 'faults', testMatch: /kill\.spec/, use: { ...devices['Desktop Chrome'] }, timeout: 30 * 60_000 },
  ],
});
