import { parseCaptureUrl } from "./network.js";

export const CAPTURE_LIMITS = Object.freeze({
  steps: 12,
  waitMs: 30000,
  actionMs: 5000,
  captureMs: 60000,
  events: 2000,
});

/** Data only. Legacy step arrays remain valid; new fields never imply new actions. */
export function validateFlow(steps = [], selectedUrl) {
  if (!Array.isArray(steps) || steps.length > CAPTURE_LIMITS.steps)
    throw new Error("Demo flow must contain at most 12 reviewed steps.");
  let waitMs = 0;
  return steps.map((step, i) => {
    const fail = (message) => {
      throw new Error(`Flow step ${i + 1}: ${message}`);
    };
    if (!step || typeof step !== "object" || Array.isArray(step))
      fail("expected an action object.");
    const fields = {
      wait: ["ms"],
      click: ["selector"],
      scroll: ["deltaY"],
      fill: ["selector", "text"],
      navigate: ["url"],
      "assert-visible": ["selector"],
    };
    if (!Object.hasOwn(fields, step.type))
      fail(
        "use wait, click, scroll, fill, navigate, or assert-visible; executable code is not supported.",
      );
    if (
      Object.keys(step).some(
        (key) =>
          !["type", "label", "pauseAfterMs", ...fields[step.type]].includes(
            key,
          ),
      )
    )
      fail("unknown action fields.");
    if (
      step.label !== undefined &&
      (typeof step.label !== "string" ||
        !step.label.trim() ||
        step.label.length > 120)
    )
      fail("label must be 1–120 characters.");
    if (
      step.pauseAfterMs !== undefined &&
      (!Number.isInteger(step.pauseAfterMs) ||
        step.pauseAfterMs < 0 ||
        step.pauseAfterMs > 10000)
    )
      fail("pauseAfterMs must be 0–10000 milliseconds.");
    waitMs += step.pauseAfterMs ?? 0;
    if (step.type === "wait") {
      if (!Number.isInteger(step.ms) || step.ms < 0 || step.ms > 10000)
        fail("wait must be 0–10000 milliseconds.");
      waitMs += step.ms;
    }
    if (waitMs > CAPTURE_LIMITS.waitMs)
      fail(
        "total wait time must not exceed 30 seconds (including explicit action pauses).",
      );
    if (
      step.type === "scroll" &&
      (!Number.isInteger(step.deltaY) || Math.abs(step.deltaY) > 2000)
    )
      fail("scroll must be an integer between -2000 and 2000.");
    if (
      ["click", "fill", "assert-visible"].includes(step.type) &&
      (typeof step.selector !== "string" ||
        !step.selector.trim() ||
        step.selector.length > 300)
    )
      fail("provide a selector of 1–300 characters.");
    if (
      step.type === "fill" &&
      (typeof step.text !== "string" || step.text.length > 2000)
    )
      fail("fill text must be at most 2000 characters.");
    if (step.type === "navigate") {
      if (
        typeof step.url !== "string" ||
        !step.url.trim() ||
        step.url.length > 2048
      )
        fail("provide a same-origin URL of 1–2048 characters.");
      try {
        const target = parseCaptureUrl(new URL(step.url, selectedUrl).href);
        if (selectedUrl && target.origin !== new URL(selectedUrl).origin)
          fail("navigation must stay on the reviewed app origin.");
      } catch (error) {
        fail(error.message);
      }
    }
    return { ...step };
  });
}
