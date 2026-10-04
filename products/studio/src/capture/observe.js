/** Runs in the main document only. Observes trusted input; never chooses actions. */
export function installObserver() {
  if (window !== window.top) return;
  const targetInfo = (element) => {
    if (!(element instanceof Element)) return null;
    const b = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id.slice(0, 120),
      role: element.getAttribute("role")?.slice(0, 80) ?? null,
      box: { x: b.x, y: b.y, width: b.width, height: b.height },
    };
  };
  for (const [domType, type] of [
    ["mousemove", "move"],
    ["click", "click"],
    ["wheel", "scroll"],
  ]) {
    window.addEventListener(
      domType,
      (event) => {
        if (!event.isTrusted) return;
        void window
          .__studioInput({
            type,
            clockMs: performance.timeOrigin + performance.now(),
            x: event.clientX,
            y: event.clientY,
            ...(type === "scroll" ? { deltaY: event.deltaY } : {}),
            target: targetInfo(event.target),
            url: location.href.slice(0, 2048),
            scroll: { x: scrollX, y: scrollY },
          })
          .catch(() => {});
      },
      { capture: true, passive: true },
    );
  }
}

/** Snapshot deliberately excludes text, input values and accessible-name content. */
export async function snapshot(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    return {
      url: location.href.slice(0, 2048),
      scroll: { x: scrollX, y: scrollY },
      viewport: {
        width: innerWidth,
        height: innerHeight,
        deviceScaleFactor: devicePixelRatio,
      },
      focus: active
        ? { tag: active.tagName.toLowerCase(), id: active.id.slice(0, 120) }
        : null,
    };
  });
}
