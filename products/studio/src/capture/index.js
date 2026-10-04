import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  createCaptureProxy,
  parseCaptureUrl,
  resolveTarget,
} from "./network.js";
import { CAPTURE_LIMITS, validateFlow } from "./flow.js";
import { installObserver, snapshot } from "./observe.js";
export { validateFlow } from "./flow.js";

/** Fresh ephemeral browser, reviewed declarative actions, original WebM + events. */
export async function captureFlow({ url, steps = [], outputDir }) {
  const selectedUrl = parseCaptureUrl(url);
  const flow = validateFlow(steps, selectedUrl);
  await resolveTarget(selectedUrl, selectedUrl);
  if (typeof outputDir !== "string" || !path.isAbsolute(outputDir))
    throw new Error("Capture output directory must be an absolute path.");
  await mkdir(outputDir, { recursive: true });
  const proxy = await createCaptureProxy(selectedUrl);
  let browser, context, timer, activeAction;
  let deadline = false,
    telemetryOverflow = false;
  const actions = [],
    observations = [],
    routes = [];
  const jsonFile = (name, value) =>
    writeFile(
      path.join(outputDir, name),
      JSON.stringify(value, null, 2) + "\n",
      { flag: "wx" },
    );
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({
      headless: true,
      timeout: 10000,
      chromiumSandbox: true,
      proxy: { server: proxy.server, bypass: "<-loopback>" },
      args: [
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--disable-quic",
      ],
    });
    timer = setTimeout(() => {
      deadline = true;
      void browser.close().catch(() => {});
    }, CAPTURE_LIMITS.captureMs);
    const viewport = { width: 1280, height: 800 };
    context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      serviceWorkers: "block",
      acceptDownloads: false,
      recordVideo: { dir: path.join(outputDir, "recordings"), size: viewport },
      permissions: [],
      locale: "en-US",
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    // All requests retain Core's DNS-pinned proxy boundary, including redirects.
    await context.route("**/*", (route) => {
      const requestUrl = new URL(route.request().url());
      return ["http:", "https:"].includes(requestUrl.protocol)
        ? route.continue()
        : route.abort();
    });
    await context.routeWebSocket(/.*/, (socket) => socket.close());
    await context.addInitScript(installObserver);
    const beforePage = performance.now();
    const page = await context.newPage();
    const started = performance.now();
    const timeMs = () => Math.max(0, Math.round(performance.now() - started));
    // Public Video API has no recorder epoch. Preserve the measured uncertainty.
    const timing = {
      schemaVersion: 2,
      epoch: "new-page-return",
      pageCreationMs: Math.ceil(started - beforePage),
      contentStartMs: 0,
      actions,
      observations,
      routes,
      limits: CAPTURE_LIMITS,
      alignment:
        "source timeMs; output time = timeMs - timeline.trim.startMs; video epoch remains approximate",
    };
    const events = [{ type: "viewport", timeMs: 0, ...viewport }];
    const beforeClock = performance.now();
    const browserClock = await page.evaluate(
      () => performance.timeOrigin + performance.now(),
    );
    const afterClock = performance.now();
    const clockOffset = (beforeClock + afterClock) / 2 - started - browserClock;
    timing.inputClockUncertaintyMs = Math.ceil((afterClock - beforeClock) / 2);
    await context.exposeBinding("__studioInput", ({ frame }, data) => {
      if (
        frame !== page.mainFrame() ||
        !data ||
        !["move", "click", "scroll"].includes(data.type)
      )
        return;
      if (
        ![data.clockMs, data.x, data.y].every(Number.isFinite) ||
        (data.type === "scroll" && !Number.isFinite(data.deltaY))
      )
        return;
      if (events.length >= CAPTURE_LIMITS.events) {
        telemetryOverflow = true;
        return;
      }
      const observedMs = Math.round(data.clockMs + clockOffset);
      if (
        observedMs < 0 ||
        observedMs > timeMs() + timing.inputClockUncertaintyMs + 50
      )
        return;
      const event = {
        type: data.type,
        timeMs: observedMs,
        x: data.x,
        y: data.y,
      };
      if (data.type === "scroll") event.deltaY = data.deltaY;
      events.push(event);
      if (data.type !== "move")
        observations.push({
          step: activeAction?.step ?? null,
          ...event,
          // Treat document metadata as bounded data, never an instruction.
          target:
            data.target && typeof data.target.tag === "string"
              ? {
                  tag: data.target.tag.slice(0, 40),
                  id: String(data.target.id ?? "").slice(0, 120),
                  role:
                    typeof data.target.role === "string"
                      ? data.target.role.slice(0, 80)
                      : null,
                  box:
                    data.target.box &&
                    ["x", "y", "width", "height"].every((k) =>
                      Number.isFinite(data.target.box[k]),
                    )
                      ? Object.fromEntries(
                          ["x", "y", "width", "height"].map((k) => [
                            k,
                            data.target.box[k],
                          ]),
                        )
                      : null,
                }
              : null,
          url: typeof data.url === "string" ? data.url.slice(0, 2048) : null,
          scroll:
            data.scroll && [data.scroll.x, data.scroll.y].every(Number.isFinite)
              ? { x: data.scroll.x, y: data.scroll.y }
              : null,
        });
    });
    page.setDefaultTimeout(CAPTURE_LIMITS.actionMs);
    context.on("page", (other) => {
      if (other !== page) void other.close().catch(() => {});
    });
    page.on("dialog", (dialog) => void dialog.dismiss().catch(() => {}));
    page.on("download", (download) => void download.cancel().catch(() => {}));
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame() && routes.length < 100)
        routes.push({
          timeMs: timeMs(),
          step: activeAction?.step ?? null,
          url: frame.url().slice(0, 2048),
        });
    });
    const video = page.video();
    const reviewedFlow = {
      schemaVersion: 2,
      url: selectedUrl.href,
      steps: flow,
    };
    await jsonFile("flow.json", reviewedFlow);
    const response = await page.goto(selectedUrl.href, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    if (!response || !response.ok())
      throw new Error(
        `URL capture failed: HTTP ${response?.status() ?? "no response"}. Check the supported public URL or selected loopback demo.`,
      );
    await page.waitForTimeout(700);
    timing.contentStartMs = timeMs();
    await page.screenshot({
      path: path.join(outputDir, "ready-frame.png"),
      type: "png",
    });
    let cursor = { x: viewport.width * 0.5, y: viewport.height * 0.5 };
    await page.mouse.move(cursor.x, cursor.y);
    const moveTo = async (x, y) => {
      const initial = { ...cursor };
      for (let j = 1; j <= 12; j++) {
        const t = j / 12,
          eased = t * t * (3 - 2 * t);
        cursor = {
          x: Math.round(initial.x + (x - initial.x) * eased),
          y: Math.round(initial.y + (y - initial.y) * eased),
        };
        await page.mouse.move(cursor.x, cursor.y);
        await page.waitForTimeout(20);
      }
    };
    for (const [index, step] of flow.entries()) {
      activeAction = {
        step: index + 1,
        type: step.type,
        label: step.label ?? `Step ${index + 1}: ${step.type}`,
        status: "running",
        startedMs: timeMs(),
      };
      actions.push(activeAction);
      activeAction.before = await snapshot(page);
      if (step.type === "wait") {
        await page.waitForTimeout(step.ms);
      } else if (step.type === "navigate") {
        const target = new URL(step.url, selectedUrl);
        const response = await page.goto(target.href, {
          waitUntil: "domcontentloaded",
          timeout: CAPTURE_LIMITS.actionMs,
        });
        if (
          (response && !response.ok()) ||
          (!response && page.url() !== target.href)
        )
          throw new Error(
            `Navigation returned HTTP ${response?.status() ?? "no response"}.`,
          );
      } else if (step.type === "scroll") {
        await page.mouse.wheel(0, step.deltaY);
      } else {
        const locator = page.locator(step.selector);
        await locator.waitFor({ state: "visible" });
        if ((await locator.count()) !== 1)
          throw new Error(
            `Selector must match exactly one element: ${step.selector}`,
          );
        activeAction.selector = step.selector;
        if (step.type !== "assert-visible") {
          if (
            step.type === "fill" &&
            (await locator.getAttribute("type"))?.toLowerCase() === "password"
          )
            throw new Error(
              "Password fields are not supported. Use a public synthetic demo.",
            );
          await locator.scrollIntoViewIfNeeded();
          const box = await locator.boundingBox();
          if (
            !box ||
            ![box.x, box.y, box.width, box.height].every(Number.isFinite)
          )
            throw new Error(`Element is not visible: ${step.selector}`);
          activeAction.targetBox = box;
          await moveTo(
            Math.max(0, Math.min(viewport.width - 1, box.x + box.width / 2)),
            Math.max(0, Math.min(viewport.height - 1, box.y + box.height / 2)),
          );
          if (step.type === "fill") await locator.fill(step.text);
          // Recheck geometry/actionability at dispatch; never click a stale point.
          else await locator.click({ timeout: CAPTURE_LIMITS.actionMs });
        } else activeAction.targetBox = await locator.boundingBox();
      }
      activeAction.dispatchedMs = timeMs();
      // Give wheel delivery and input-binding messages two presentation frames.
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      await page.waitForTimeout(
        step.pauseAfterMs ?? (step.type === "wait" ? 0 : 450),
      );
      activeAction.after = await snapshot(page);
      activeAction.endedMs = timeMs();
      if (["click", "scroll"].includes(step.type)) {
        const observed = observations.find(
          (o) => o.step === index + 1 && o.type === step.type,
        );
        if (!observed)
          throw new Error(
            `No trusted ${step.type} event was observed in the main document. Frames are not supported.`,
          );
        activeAction.inputTimeMs = observed.timeMs;
        cursor = { x: observed.x, y: observed.y };
      }
      activeAction.status = "completed";
      activeAction = undefined;
    }
    await page.waitForTimeout(1100);
    if (telemetryOverflow)
      throw new Error(
        "Capture input event limit exceeded. Shorten the reviewed flow.",
      );
    await context.close();
    context = undefined;
    const mediaPath = path.join(outputDir, "original.webm");
    await video.saveAs(mediaPath);
    if ((await stat(mediaPath)).size === 0)
      throw new Error("Browser capture returned an empty recording.");
    events.sort((a, b) => a.timeMs - b.timeMs);
    timing.status = "completed";
    await writeFile(
      path.join(outputDir, "events.ndjson"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
      { flag: "wx" },
    );
    await jsonFile("capture-timing.json", timing);
    return {
      mediaPath,
      events,
      flow: reviewedFlow,
      timing,
      readyFramePath: path.join(outputDir, "ready-frame.png"),
    };
  } catch (error) {
    const detail = deadline
      ? "Capture exceeded the 60-second limit. Shorten the flow and try again."
      : String(error.message).split("\n")[0].slice(0, 500);
    if (activeAction) {
      activeAction.status = "failed";
      activeAction.error = detail;
    }
    const message = `Capture failed${activeAction ? ` at step ${activeAction.step} (${activeAction.label})` : ""}: ${detail}`;
    const report = {
      schemaVersion: 2,
      status: "failed",
      error: message,
      actions,
      observations,
      routes,
    };
    await jsonFile("capture-failure.json", report).catch(() => {});
    const failure = new Error(message, { cause: error });
    failure.report = report;
    throw failure;
  } finally {
    clearTimeout(timer);
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await proxy.close();
  }
}
