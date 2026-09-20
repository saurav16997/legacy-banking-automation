import { chromium, type Browser } from "playwright";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTargetApp } from "../../target_app/server.js";

describe("target portal Playwright smoke test", () => {
  const target = createTargetApp();
  const server = target.app.listen(0);
  let browser: Browser;
  let baseUrl: string;

  beforeAll(async () => {
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });

  it("walks the portal to the final review screen", async () => {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/login`);
    await page.getByLabel("Operator username").fill("demo.operator");
    await page.getByLabel("Password").fill("creditunion-demo");
    await page.getByRole("button", { name: "Log in" }).click();
    await page.getByRole("link", { name: "Member Search", exact: true }).first().click();
    await page.getByLabel("Member ID").fill("M-10042");
    await page.getByRole("button", { name: "Search" }).click();
    await page.getByRole("link", { name: "Add savings subaccount" }).click();
    await page.getByLabel("Product").selectOption("Growth Savings");
    await page.getByLabel("Account nickname").fill("Vacation Fund");
    await page.getByLabel("Initial deposit").fill("250.00");
    await page.getByLabel("Funding account").selectOption("CHK-1842");
    await page.getByRole("button", { name: "Continue to review" }).click();

    expect(await page.locator('[data-page-state="ready-for-review"]').count()).toBe(1);
    expect(await page.getByRole("heading", { name: "Review Savings Subaccount" }).isVisible()).toBe(
      true,
    );
    expect(await page.getByRole("button", { name: "Open Account" }).isVisible()).toBe(true);
    expect(target.fixtures.findMember("M-10042")?.accounts).toHaveLength(1);
    await page.close();
  });
});
