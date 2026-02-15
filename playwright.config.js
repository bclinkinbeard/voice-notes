// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',

  /* Maximum time one test can run */
  timeout: 30_000,

  expect: {
    /* Models load slowly, so give assertions extra time */
    timeout: 60_000,
  },

  /* Fail the build on CI if you accidentally left test.only in the source code */
  forbidOnly: !!process.env.CI,

  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,

  /* Reporter to use */
  reporter: 'html',

  use: {
    /* Base URL for page.goto('/') etc. */
    baseURL: 'http://localhost:8090',

    /* Capture screenshot on failure */
    screenshot: 'only-on-failure',

    /* Collect trace on first retry */
    trace: 'on-first-retry',
  },

  /* Only run in Chromium */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  /* Serve the static app before running tests */
  webServer: {
    command: 'python3 -m http.server 8090',
    port: 8090,
    reuseExistingServer: !process.env.CI,
  },
});
