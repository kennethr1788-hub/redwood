import { defineConfig } from "@playwright/test";
import path from "node:path";
import { randomUUID } from "node:crypto";
const workspace = (process.env.LF_E2E_WORKSPACE ||= path.resolve(
  ".local/e2e-" + randomUUID(),
));
export default defineConfig({
  testDir: "./tests/e2e",
  workers: 1,
  timeout: 180000,
  use: {
    baseURL: "http://127.0.0.1:4187",
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  reporter: [["list"]],
  webServer: {
    command: "npm start",
    url: "http://127.0.0.1:4187",
    timeout: 60000,
    reuseExistingServer: false,
    env: { LF_PORT: "4187", LF_WORKSPACE: workspace },
  },
});
