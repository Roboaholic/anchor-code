import { expect, test, type Page } from "@playwright/test";

async function openBaseline(page: Page) {
  await page.goto("/?baseline=1");
  await expect(page.getByRole("heading", { name: "Review 变更" })).toBeVisible();
  await expect(page.getByRole("button", { name: "比较当前工作区" })).toBeEnabled();
}

test("scanner frame remains square and inside the camera viewport", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "扫描 PC 配对二维码" }).click();
  await expect(page.getByRole("dialog", { name: "扫码连接" })).toBeVisible();

  const frame = page.locator(".scanner-frame");
  const view = page.locator(".scanner-view");
  const scanLine = frame.locator("span");
  await expect(frame).toBeVisible();

  const boxes = await Promise.all([frame.boundingBox(), view.boundingBox(), scanLine.boundingBox()]);
  const [frameBox, viewBox, lineBox] = boxes;
  expect(frameBox).not.toBeNull();
  expect(viewBox).not.toBeNull();
  expect(lineBox).not.toBeNull();
  expect(Math.abs(frameBox!.width - frameBox!.height)).toBeLessThanOrEqual(2);
  expect(frameBox!.x).toBeGreaterThanOrEqual(viewBox!.x);
  expect(frameBox!.y).toBeGreaterThanOrEqual(viewBox!.y);
  expect(frameBox!.x + frameBox!.width).toBeLessThanOrEqual(viewBox!.x + viewBox!.width + 1);
  expect(frameBox!.y + frameBox!.height).toBeLessThanOrEqual(viewBox!.y + viewBox!.height + 1);
  expect(lineBox!.y).toBeGreaterThanOrEqual(frameBox!.y);
  expect(lineBox!.y + lineBox!.height).toBeLessThanOrEqual(frameBox!.y + frameBox!.height + 1);
});

test("connected mobile shell keeps navigation visible and Review scrollable", async ({ page }) => {
  await openBaseline(page);
  for (const name of ["Review", "文件", "Agent", "评论"]) {
    await expect(page.getByRole("button", { name })).toBeVisible();
  }

  const dimensions = await page.evaluate(() => ({
    viewport: window.innerHeight,
    document: document.documentElement.scrollHeight,
  }));
  expect(dimensions.document).toBeGreaterThan(dimensions.viewport);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Agent" })).toBeVisible();
});

test("Agent creation opens a full-screen terminal and returns to the shared shell", async ({ page }) => {
  await openBaseline(page);
  await page.getByRole("button", { name: "Agent" }).click();
  await page.getByRole("button", { name: "启动 Agent 会话" }).click();

  await expect(page.getByRole("heading", { name: "Baseline Agent Session" })).toBeVisible();
  await expect(page.locator(".xterm-mobile")).toBeVisible();
  await expect(page.locator(".xterm-rows")).toContainText("Anchor Agent ready");
  await expect(page.locator(".app-shell")).toHaveClass(/app-shell--agent-terminal/);
  await expect(page.locator(".bottom-nav")).toBeHidden();

  await page.getByRole("button", { name: "返回 Agent 会话列表" }).click();
  await expect(page.locator(".app-shell")).not.toHaveClass(/app-shell--agent-terminal/);
  await expect(page.locator(".bottom-nav")).toBeVisible();
  await expect(page.getByText("Baseline Agent Session", { exact: true })).toBeVisible();
});

test("Review line comments are persisted through the mobile workflow", async ({ page }) => {
  await openBaseline(page);
  await page.getByRole("button", { name: "比较当前工作区" }).click();
  await page.getByRole("button", { name: /src\/example\.ts/ }).click();
  await page.locator(".inline-diff__row.is-added:not([disabled])").first().click();
  await page.getByRole("button", { name: "添加评论" }).click();
  await page.getByPlaceholder("说明问题、建议或需要 Agent 修改的内容…").fill("Keep the APK baseline stable");
  await page.getByRole("button", { name: "保存评论" }).click();
  await expect(page.getByText("审阅意见已记录")).toBeVisible();
});

test("Markdown and Mermaid render without modern hasOwn or Array.at built-ins", async ({ page }) => {
  await page.addInitScript(() => {
    // Model an older Android System WebView before the app compatibility layer runs.
    Reflect.deleteProperty(Object, "hasOwn");
    Reflect.deleteProperty(Array.prototype, "at");
  });
  await openBaseline(page);
  await page.getByRole("button", { name: "文件" }).click();
  await page.getByRole("button", { name: /README\.md/ }).click();

  await expect(page.getByRole("heading", { name: "Anchor Mobile Baseline" })).toBeVisible();
  await expect(page.locator(".mermaid-diagram svg")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".document-error, .mermaid-error")).toHaveCount(0);
});
