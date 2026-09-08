import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
export default defineConfig({
  testDir: "./tests",
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5181",
    viewport: { width: 1440, height: 1000 },
    launchOptions: existsSync(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    )
      ? {
          executablePath:
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        }
      : {},
  },
  webServer: {
    command: "npm run dev -- --port 5181",
    url: "http://127.0.0.1:5181",
    reuseExistingServer: false,
  },
});
