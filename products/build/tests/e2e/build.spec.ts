import { expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
const evidence=process.env.LF_EVIDENCE_DIR||"evidence";
test("owned source: create, trust, preview, edit, check, reopen and recover from a failed build", async ({
  page,
  request,
}) => {
  await fs.mkdir(evidence,{recursive:true});
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Make something/ }),
  ).toBeVisible();
  await page.screenshot({ path: path.join(evidence,"home-desktop.png"), fullPage: true });
  await page.getByLabel("Project name", { exact: true }).fill("Garden Notes");
  await page
    .getByLabel("What would you like to build?", { exact: true })
    .fill(
      "A calm garden journal for collecting planting ideas and tracking small seasonal milestones.",
    );
  await page
    .getByLabel("Design reference path or URL")
    .fill("/design/garden-reference.png");
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Garden Notes", exact: true }),
  ).toBeVisible();
  const folder = path.join(process.env.LF_E2E_WORKSPACE!, "garden-notes");
  expect(
    await fs.readFile(path.join(folder, ".launchforge/brief.md"), "utf8"),
  ).toContain("/design/garden-reference.png");
  expect(await fs.stat(path.join(folder, "src/main.tsx"))).toBeTruthy();
  await expect(
    page.getByRole("button", { name: "Install dependencies", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("I trust this project’s code for this session.")
    .check();
  await page
    .getByRole("button", { name: "Trust project", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("trusted");
  await page
    .getByRole("button", { name: "Install dependencies", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Dependencies installed",
    { timeout: 150000 },
  );
  await page
    .getByRole("button", { name: "Start preview", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Local preview is running",
    { timeout: 30000 },
  );
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  const preview = page.frameLocator('iframe[title="Project preview"]');
  await expect(
    preview.getByRole("heading", { name: /Good things/ }),
  ).toBeVisible();
  await preview.getByRole("link", { name: "Make your first move" }).click();
  await preview
    .getByRole("textbox", { name: "New milestone" })
    .fill("Plant the herb garden");
  await preview.getByRole("button", { name: "Add milestone" }).click();
  await expect(preview.getByText("Plant the herb garden")).toBeVisible();
  await preview.getByRole("checkbox").check();
  await expect(preview.getByRole("checkbox")).toBeChecked();
  await preview.getByRole("link", { name: "About", exact: true }).click();
  await expect(
    preview.getByRole("heading", { name: /Your idea/ }),
  ).toBeVisible();
  await preview.getByRole("link", { name: "Overview", exact: true }).click();
  // Ordinary external source edits are reflected in the running preview, without any LaunchForge API.
  const sourceData = path.join(folder, "src/project.json");
  await fs.writeFile(
    sourceData,
    JSON.stringify(
      {
        name: "Garden Notes",
        brief:
          "An externally edited garden journal. Every source file belongs to you.",
      },
      null,
      2,
    ),
  );
  await expect(
    preview.getByText(/An externally edited garden journal/),
  ).toBeVisible({ timeout: 15000 });
  await page
    .getByLabel("WHAT YOU’RE MAKING")
    .fill(
      "A seasonal garden journal with a calendar and an editable planting checklist.",
    );
  await page.getByRole("button", { name: "Save brief & handoff" }).click();
  await expect(page.getByRole("status")).toContainText("Brief saved");
  await page.getByRole("button", { name: "Run checks", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Typecheck, build and project tests passed",
    { timeout: 120000 },
  );
  await page.screenshot({
    path: path.join(evidence,"checks-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await expect(
    preview.getByRole("heading", { name: /Good things/ }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(evidence,"preview-desktop.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Close project", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: /Make something/ }),
  ).toBeVisible();
  await page
    .locator(".project-card")
    .filter({ hasText: "Garden Notes" })
    .click();
  await expect(page.getByLabel("WHAT YOU’RE MAKING")).toHaveValue(
    "A seasonal garden journal with a calendar and an editable planting checklist.",
  );
  await page.reload();
  await expect(page.getByLabel("WHAT YOU’RE MAKING")).toHaveValue(
    "A seasonal garden journal with a calendar and an editable planting checklist.",
  );
  await page
    .getByRole("button", { name: "Start preview", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Local preview is running",
  );
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await preview.getByRole("link", { name: "Roadmap", exact: true }).click();
  await expect(preview.getByRole("checkbox")).toBeChecked();
  await page.getByRole("button", { name: "Stop preview", exact: true }).click();
  expect(errors).toEqual([]);
  // Invalid source fails visibly; the check operation must not repair/overwrite user content.
  const source = path.join(folder, "src/main.tsx");
  const original = await fs.readFile(source, "utf8");
  const broken = original + "\nconst broken: string = 123;\n";
  await fs.writeFile(source, broken);
  await page.getByRole("button", { name: "Run checks", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("typecheck failed", {
    timeout: 30000,
  });
  expect(await fs.readFile(source, "utf8")).toBe(broken);
  await page.screenshot({
    path: path.join(evidence,"failure-desktop.png"),
    fullPage: true,
  });
  await fs.writeFile(source, original);
  await page.getByRole("button", { name: "Run checks", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Typecheck, build and project tests passed",
    { timeout: 120000 },
  );
  // The preview origin cannot command the workbench, even with the custom header.
  const crossOrigin = await request.post("/api/projects/garden-notes/action", {
    headers: { "X-LaunchForge": "1", Origin: "http://127.0.0.1:5555" },
    data: { action: "install" },
  });
  expect(crossOrigin.status()).toBe(403);
  const rebound = await request.get("/api/projects", {
    headers: { "X-LaunchForge": "1", Host: "evil.example:4187" },
  });
  expect(rebound.status()).toBe(403);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Create project", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: path.join(evidence,"home-mobile.png"), fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page
    .locator(".project-card")
    .filter({ hasText: "Garden Notes" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Garden Notes", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("WHAT YOU’RE MAKING")).toHaveValue(
    "A seasonal garden journal with a calendar and an editable planting checklist.",
  );
  await page.locator(".workbench").screenshot({
    path: path.join(evidence,"workspace-mobile.png"),
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("open an existing supported repo without overwriting its instructions or executing code", async ({
  page,
}) => {
  const folder = path.join(process.env.LF_E2E_WORKSPACE!, "existing-app");
  await fs.cp(path.resolve("templates/react"), folder, {
    recursive: true,
    filter: (source) => !source.includes("node_modules"),
  });
  await fs.writeFile(
    path.join(folder, "AGENTS.md"),
    "Preserve these existing project instructions.",
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open existing", exact: true })
    .click();
  await page.getByLabel("Project name", { exact: true }).fill("Existing App");
  await page
    .getByLabel("Existing folder name in your workspace")
    .fill("existing-app");
  await page
    .getByLabel("What would you like to build?", { exact: true })
    .fill("Add an accessible calendar to the existing application.");
  await page.getByRole("button", { name: "Open project", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Existing App", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Run checks", exact: true }),
  ).toBeDisabled();
  expect(await fs.readFile(path.join(folder, "AGENTS.md"), "utf8")).toBe(
    "Preserve these existing project instructions.",
  );
  expect(await fs.readdir(folder)).not.toContain("node_modules");
  await page.getByRole("tab", { name: "Source", exact: true }).click();
  await expect(page.getByText("Your source. No exit required.")).toBeVisible();
  await expect(
    page.getByText("No project Git repository", { exact: true }).first(),
  ).toBeVisible();
});
