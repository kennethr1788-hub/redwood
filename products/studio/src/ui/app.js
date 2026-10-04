import { DISPLAY_NAMES } from "/display-names.js";
import {resolveFocusAtSourceTime} from '/focus/blocks.js';
import {timelineRanges,retainedDurationMs,sourceToOutputMs,outputToSourceMs,reconcileTrim} from '/timeline/project.js';
const $ = (id) => document.getElementById(id);
const state = {
  token: "",
  projects: [],
  project: null,
  dirty: false,
  busy: false,
  rendering: false,
  inputMode: "import",
  view: "editor",
  finish: "draft",
  notificationTimer: null,
};
const video = $("source-video");
const compareVideo = $("compare-video");
const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const clock = (ms) =>
  `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${((ms / 1000) % 60).toFixed(1).padStart(4, "0")}`;
const duration = (ms) => `${(ms / 1000).toFixed(1)}s`;
const projectURL = () =>
  `/api/projects/${encodeURIComponent(state.project.studio.id)}`;

async function api(path, options = {}) {
  const headers = { ...options.headers };
  if (options.method && options.method !== "GET")
    headers["X-Studio-Token"] = state.token;
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}
function notify(message, error = false) {
  clearTimeout(state.notificationTimer);
  $("notification-text").textContent = message;
  $("notification").classList.toggle("error", error);
  $("notification").classList.remove("hidden");
  if (!error)
    state.notificationTimer = setTimeout(
      () => $("notification").classList.add("hidden"),
      5000,
    );
}
function progress(title, message) {
  $("progress-title").textContent = title;
  $("progress-message").textContent = message;
  const panel = $("progress-panel");
  panel.classList.remove("hidden", "failed");
  $("progress-spinner").classList.remove("hidden");
  $("dismiss-progress").classList.add("hidden");
  const steps = $("progress-steps");
  const rendering = /render/i.test(title);
  steps.classList.toggle("hidden", !rendering);
  if (!rendering) return;
  const items = [...steps.querySelectorAll("li")];
  let hit = -1;
  items.forEach((item, index) => {
    if (new RegExp(item.dataset.match, "i").test(message || "")) hit = index;
  });
  items.forEach((item, index) => {
    item.classList.toggle("done", hit > index);
    item.classList.toggle("current", hit === index);
  });
}
function showFailure(title, message) {
  progress(title, message);
  $("progress-panel").classList.add("failed");
  $("progress-spinner").classList.add("hidden");
  $("dismiss-progress").classList.remove("hidden");
  $("progress-steps").classList.add("hidden");
}
function setBusy(busy) {
  state.busy = busy;
  $("save").disabled =
    !state.project || busy || state.rendering || !state.dirty;
  $("render").disabled = !state.project || busy || state.rendering;
  $("new-project").disabled = busy || state.rendering;
  $("create-project").disabled = busy;
  $("close-dialog").disabled = busy;
  document
    .querySelectorAll(".inspector input,.inspector textarea,.inspector select,.inspector button")
    .forEach((item) => {
      item.disabled = busy || state.rendering;
    });
  document.querySelectorAll(".project-item").forEach((item) => {
    item.disabled = busy || state.rendering;
  });
  if (
    !busy &&
    !state.rendering &&
    !$("progress-panel").classList.contains("failed")
  )
    $("progress-panel").classList.add("hidden");
}
function markDirty() {
  state.dirty = true;
  $("cover-download").classList.add("hidden");
  if(state.project?.inspection)$("inspection-status").textContent="STALE · unsaved presentation edits. Save and inspect again.";
  $("saved-state").textContent = "Unsaved changes";
  $("saved-state").classList.add("dirty");
  $("save").disabled = state.busy || state.rendering;
}
function markSaved() {
  state.dirty = false;
  $("saved-state").textContent = "Saved locally";
  $("saved-state").classList.remove("dirty");
  $("save").disabled = true;
}
function switchView(view) {
  state.view = view;
  const hasProject = Boolean(state.project);
  document.body.classList.toggle("has-project", hasProject);
  $("empty-state").classList.toggle("hidden", hasProject);
  $("editor").classList.toggle("hidden", !hasProject || view !== "editor");
  $("exports-view").classList.toggle(
    "hidden",
    !hasProject || view !== "exports",
  );
  for (const tab of ["editor", "exports"]) {
    $(`${tab}-tab`).classList.toggle("active", view === tab);
    $(`${tab}-tab`).setAttribute("aria-pressed", String(view === tab));
  }
  if (view === "exports") markStep("exports");
  if (view !== "editor") {
    video.pause();
    compareVideo.pause();
  }
}
function markStep(step) {
  for (const button of document.querySelectorAll("#step-rail [data-step]")) {
    const on = button.dataset.step === step;
    button.classList.toggle("current", on);
    if (on) {
      button.setAttribute("aria-current", "true");
      const rail = $("step-rail");
      const itemBounds = button.getBoundingClientRect();
      const railBounds = rail.getBoundingClientRect();
      if (itemBounds.left < railBounds.left)
        rail.scrollLeft += itemBounds.left - railBounds.left;
      else if (itemBounds.right > railBounds.right)
        rail.scrollLeft += itemBounds.right - railBounds.right;
    } else button.removeAttribute("aria-current");
  }
}
async function refreshLibrary() {
  state.projects = await api("/api/projects");
  $("project-count").textContent = state.projects.length;
  $("project-list").innerHTML = state.projects.length
    ? state.projects
        .map((item) => {
          const project = item.studio || item;
          return `<button class="project-item ${state.project?.studio.id === project.id ? "active" : ""}" data-project="${escapeHTML(project.id)}"><span class="project-glyph">▣</span><span><strong>${escapeHTML(project.name)}</strong><small>${project.createdAt ? escapeHTML(new Date(project.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })) : "Saved locally"}</small></span></button>`;
        })
        .join("")
    : '<p class="project-empty">Your next great demo starts here. Create a project to begin.</p>';
  $("project-list")
    .querySelectorAll("[data-project]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        openProject(button.dataset.project),
      ),
    );
}
function mayLeave() {
  return (
    !state.dirty ||
    window.confirm(
      "Discard your unsaved timeline changes? Your last saved project will remain intact.",
    )
  );
}
async function openProject(id) {
  if (state.busy || state.rendering || !mayLeave()) return;
  setBusy(true);
  try {
    const project = await api(`/api/projects/${encodeURIComponent(id)}`);
    loadProject(project);
    await refreshLibrary();
  } catch (error) {
    notify(error.message, true);
  } finally {
    setBusy(false);
  }
}
function loadProject(project) {
  video.pause();
  state.project = project;
  localStorage.setItem("launchforge.lastProject", project.studio.id);
  $("project-name").textContent = project.studio.name;
  document.title = `${project.studio.name} · ${DISPLAY_NAMES.umbrella} ${DISPLAY_NAMES.studio}`;
  const timeline = project.timeline;
  $("title").value = timeline.title;
  $("subtitle").value = timeline.subtitle;
  $("zoom").value = timeline.zoom;
  $("landscape-fit").value=timeline.framing?.landscape||"cover";$("vertical-fit").value=timeline.framing?.vertical||"cover";
  $("inspect-time").value=(timeline.coverTimeMs||0)/1000;
  showInspection(project.inspection);
  $("cover-download").classList.toggle("hidden",!project.coverReview||project.coverReview.stale);
  if(project.coverReview&&!project.coverReview.stale)$("cover-download").href=`/inspection/${project.studio.id}/reviewed-cover.png?v=${project.coverReview.frameHash}`;
  $("recover-presentation").disabled=!project.recoveryAvailable;
  $("focus-x").value = Math.round(timeline.focus.x * 100);
  $("focus-y").value = Math.round(timeline.focus.y * 100);
  $("cursor").checked = timeline.cursor;
  $("trim-start").value = timeline.trim.startMs / 1000;
  $("trim-end").value = timeline.trim.endMs / 1000;
  $("trim-start").max = project.studio.asset.durationMs / 1000;
  $("trim-end").max = project.studio.asset.durationMs / 1000;
  document
    .querySelectorAll("[data-theme]")
    .forEach((button) =>
      button.classList.toggle(
        "selected",
        button.dataset.theme === timeline.theme,
      ),
    );
  const hasEvents = project.events?.some((event) =>
    ["move", "click"].includes(event.type),
  );
  $("cursor-note").textContent = hasEvents
    ? "Uses recorded interaction metadata; render smooths the motion."
    : "No cursor metadata in this source. Existing recorded cursor stays in the video.";
  $("preview-domain").textContent =
    project.studio.input.kind === "url"
      ? new URL(project.studio.input.url).hostname
      : "Imported recording";
  video.src = `/media/${encodeURIComponent(project.studio.id)}/original`;
  video.load();
  compareVideo.src = video.src;
  compareVideo.load();
  const asset = project.studio.asset;
  const kind =
    project.studio.input.kind === "url" ? "URL capture" : "Imported recording";
  $("source-facts").textContent = `${kind} · ${asset.width}×${asset.height} · ${duration(asset.durationMs)} · original preserved`;
  $("clip-name").textContent =
    project.studio.input.kind === "url"
      ? "Web flow · original recording"
      : "Imported · original recording";
  renderCaptionEditor();
  renderFocusBlocks();
  showTranscriptProposal();
  showSilence();
  applyPreview();
  renderExports();
  markSaved();
  switchView("editor");
  markStep("focus");
}
function collectTimeline() {
  const timeline = structuredClone(state.project.timeline);
  timeline.title = $("title").value;
  timeline.subtitle = $("subtitle").value;
  timeline.theme =
    document.querySelector("[data-theme].selected")?.dataset.theme || "aurora";
  timeline.zoom = Number($("zoom").value);
  timeline.focus = {
    x: Number($("focus-x").value) / 100,
    y: Number($("focus-y").value) / 100,
  };
  timeline.cursor = $("cursor").checked;
  timeline.framing={landscape:$("landscape-fit").value,vertical:$("vertical-fit").value};
  timeline.trim = {
    startMs: Math.round(Number($("trim-start").value) * 1000),
    endMs: Math.round(Number($("trim-end").value) * 1000),
  };
  timeline.focusBlocks=collectFocusBlocks();
  timeline.captions = [
    ...$("caption-list").querySelectorAll(".caption-item"),
  ].map((row) => ({
    startMs: Math.round(Number(row.querySelector("[data-start]").value) * 1000),
    endMs: Math.round(Number(row.querySelector("[data-end]").value) * 1000),
    text: row.querySelector("[data-text]").value,
  }));
  try{return reconcileTrim(timeline,state.project.timeline,state.project.studio.asset.durationMs);}catch{return timeline;}
}
function validateTimeline(timeline) {
  const length = state.project.studio.asset.durationMs;
  if (
    !Number.isFinite(timeline.trim.startMs) ||
    !Number.isFinite(timeline.trim.endMs) ||
    timeline.trim.startMs < 0 ||
    timeline.trim.endMs > length ||
    timeline.trim.endMs - timeline.trim.startMs < 500
  )
    throw new Error(
      `Trim must retain at least 0.5 seconds, start at 0 or later, and end within ${duration(length)}.`,
    );
  if (
    ![timeline.focus.x, timeline.focus.y].every(
      (n) => Number.isFinite(n) && n >= 0 && n <= 1,
    )
  )
    throw new Error("Focus X and Y must be between 0 and 100.");
  for (const caption of timeline.captions) {
    if (
      !caption.text.trim() ||
      !Number.isFinite(caption.startMs) ||
      !Number.isFinite(caption.endMs) ||
      caption.startMs < 0 ||
      caption.endMs <= caption.startMs ||
      caption.endMs > length
    )
      throw new Error(
        `Each caption needs text and a valid time range within ${duration(length)}.`,
      );
  }
}
function applyPreview() {
  if (!state.project) return;
  const timeline = collectTimeline();
  const composition = $("composition");
  composition.classList.remove("aurora", "midnight", "ember");
  composition.classList.add(timeline.theme);
  $("preview-title").textContent = timeline.title;
  $("preview-subtitle").textContent = timeline.subtitle;
  $("zoom-value").textContent = `${timeline.zoom.toFixed(2)}×`;
  const picture = $("picture");
  if (state.finish === "raw") {
    picture.style.transform = "none";
    picture.style.transformOrigin = "50% 50%";
  } else {
    picture.style.transformOrigin = `${timeline.focus.x * 100}% ${timeline.focus.y * 100}%`;
    picture.style.transform = `scale(${timeline.zoom})`;
  }
  const reticle = $("focus-reticle");
  reticle.hidden = state.finish === "raw";
  reticle.style.left = `${timeline.focus.x * 100}%`;
  reticle.style.top = `${timeline.focus.y * 100}%`;
  paintTimeline(timeline);
  $("preview-truth").textContent = previewTruth();
  const trimmedLength=retainedDurationMs(timelineRanges(timeline));
  $("retained-ranges").textContent=`Retained: ${timeline.rangeSet.ranges.map(r=>`${r.startMs/1000}–${r.endMs/1000}s`).join(", ")} · output ${duration(trimmedLength)}`;
  $("clip-duration").textContent = duration(trimmedLength);
  $("play-duration").textContent = clock(trimmedLength);
  $("caption-track-label").textContent = timeline.captions.length
    ? `${timeline.captions.length} caption${timeline.captions.length === 1 ? "" : "s"} · timed to original media`
    : "Add captions to tell the story";
  $("seek").min = 0;
  $("seek").max = Math.max(0,trimmedLength-1);
  updatePlayback();
}
function previewTruth() {
  const vertical = $("stage").classList.contains("vertical");
  const aspect = vertical
    ? ($("vertical-fit").value==="fit" ? "9:16 editor draft. Final portrait fits the whole recording with centered letterboxing and no focus zoom. Inspect the final frame below." : "9:16 draft. The 720×1280 export crops and reframes around your saved focus without stretching; surrounding content may be cropped. Inspect the final frame below.")
    : "16:9 draft. The rendered landscape file is 1280×720.";
  if (state.finish === "raw")
    return "Raw recording. Zoom, frame, captions, and the captured-cursor overlay are hidden. The source file is unchanged.";
  if (state.finish === "split")
    return `Left is the raw picture. Right is the editor draft. ${aspect} This draft is not a pixel match of the export: zoom is instant here and eased in the file.`;
  return `Editor draft. ${aspect} Zoom, caption placement, and cursor smoothing in the file are finished at render time.`;
}
function paintTimeline(timeline) {
  const length = Math.max(1, state.project.studio.asset.durationMs);
  const start = (timeline.trim.startMs / length) * 100;
  const width = ((timeline.trim.endMs - timeline.trim.startMs) / length) * 100;
  $("trim-window").style.left = `${start}%`;
  $("trim-window").style.width = `${Math.max(0, width)}%`;
  const intervals = window.matchMedia("(max-width: 720px)").matches ? 4 : 8;
  const ticks = [];
  for (let i = 0; i <= intervals; i++)
    ticks.push(
      `<span style="left:clamp(2.5ch, ${(i / intervals) * 100}%, calc(100% - 2.5ch))">${clock(length * i / intervals)}</span>`,
    );
  $("timeline-ruler").innerHTML = ticks.join("");
  $("caption-track").classList.toggle("has-captions", timeline.captions.length > 0);
  $("caption-blocks").innerHTML = timeline.captions
    .map((caption) => {
      const left = (caption.startMs / length) * 100;
      const span = Math.max(
        1.2,
        ((caption.endMs - caption.startMs) / length) * 100,
      );
      return `<span class="caption-block" style="left:${left}%;width:${span}%" title="${escapeHTML(caption.text)}"></span>`;
    })
    .join("");
}
function renderCaptionEditor() {
  const captions = state.project.timeline.captions;
  $("caption-list").innerHTML = captions
    .map(
      (caption, index) =>
        `<div class="caption-item"><label>Caption ${index + 1}<textarea data-text rows="2" maxlength="180">${escapeHTML(caption.text)}</textarea></label><div class="two-columns"><label>Start<input data-start type="number" min="0" step="0.1" value="${caption.startMs / 1000}"></label><label>End<input data-end type="number" min="0.1" step="0.1" value="${caption.endMs / 1000}"></label></div><button type="button" class="caption-remove" data-remove="${index}">Remove caption</button></div>`,
    )
    .join("");
  $("caption-list")
    .querySelectorAll("[data-remove]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        const timeline = collectTimeline();
        timeline.captions.splice(Number(button.dataset.remove), 1);
        state.project.timeline = timeline;
        renderCaptionEditor();
        markDirty();
        applyPreview();
      }),
    );
}
function updatePlayback() {
  if (!state.project) return;
  const timeline = collectTimeline();
  const ms = Math.round(video.currentTime * 1000);
  const ranges=timelineRanges(timeline);
  const relative=sourceToOutputMs(ranges,Math.min(ms,ranges.sourceDurationMs))??retainedDurationMs(ranges);
  $("play-time").textContent = clock(relative);
  $("seek").value = relative;
  const span = retainedDurationMs(ranges);
  const within = Math.min(100, Math.max(0, (relative / span) * 100));
  $("clip-progress").style.width = `${within}%`;
  $("playhead").style.left = `${within}%`;
  if (
    state.finish === "split" &&
    compareVideo.readyState >= 1 &&
    Math.abs(compareVideo.currentTime - video.currentTime) > 0.2
  )
    compareVideo.currentTime = video.currentTime;
  const caption = timeline.captions.find(
    (item) => ms >= item.startMs && ms < item.endMs,
  );
  $("preview-caption").textContent = caption?.text || "";
  $("preview-caption").classList.toggle("hidden", !caption);
  const events = state.project.events || [];
  let cursorEvent;
  for (const event of events)
    if ((event.type === "move" || event.type === "click") && event.timeMs <= ms && ranges.ranges.some(r=>event.timeMs>=r.startMs&&ms<r.endMs))
      cursorEvent = event;
  let focus=null;try{focus=resolveFocusAtSourceTime(timeline.focusBlocks,Math.min(ms,ranges.sourceDurationMs),{sourceDurationMs:ranges.sourceDurationMs,ratio:$('stage').classList.contains('vertical')?'9:16':'16:9'});}catch{/* Incomplete draft fields are validated on save. */}
  const policy=focus?.cursorPolicy||'preserve';
  const showCursor = policy!=='off'&&(policy!=='preserve'||timeline.cursor)&&cursorEvent&&ms-cursorEvent.timeMs<3000;
  if(timeline.focusBlocks.length&&state.finish!=='raw'){
    const target=focus?.target||{x:.5,y:.5};$('picture').style.transformOrigin=`${target.x*100}% ${target.y*100}%`;
    $('picture').style.transform=`scale(${focus?.zoom||1})`;
  }
  $("preview-cursor").classList.toggle("hidden", !showCursor);
  if (showCursor) {
    const asset = state.project.studio.asset;
    $("preview-cursor").style.left =
      `${Math.max(0, Math.min(100, (cursorEvent.x / asset.width) * 100))}%`;
    $("preview-cursor").style.top =
      `${Math.max(0, Math.min(100, (cursorEvent.y / asset.height) * 100))}%`;
  }
}
async function saveTimeline() {
  if (!state.project) return;
  const timeline = collectTimeline();
  validateTimeline(timeline);
  const project = await api(`${projectURL()}/timeline`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision: state.project.studio.revision, timeline }),
  });
  state.project = project;
  markSaved();
  renderExports();
  showInspection(project.inspection);
  return project;
}
function receiptHTML(files) {
  if (!state.project) return "";
  if (!files.length)
    return `<article class="receipt"><p class="eyebrow">Export receipt</p><h3>No files yet</h3><p class="field-note">Render writes landscape 1280×720, vertical 720×1280, a still, a GIF, captions, and a local share page. Nothing is listed until that render succeeds. A failed render keeps the previous files.</p></article>`;
  const timeline = state.project.timeline;
  const stale = files.some((file) => file.stale);
  const rows = [
    ["Trim", duration(Math.max(0, timeline.trim.endMs - timeline.trim.startMs))],
    ["Zoom", `${Number(timeline.zoom).toFixed(2)}×`],
    [
      "Focus",
      `${Math.round(timeline.focus.x * 100)}%, ${Math.round(timeline.focus.y * 100)}%`,
    ],
    ["Background", timeline.theme],
    ["Cursor", timeline.cursor
      ? state.project.events?.some((event) => ["move", "click"].includes(event.type))
        ? "Captured cursor on" : "No cursor metadata; recorded pixels unchanged"
      : "Overlay off; recorded pixels unchanged"],
    ["Captions", String(timeline.captions.length)],
    ["Landscape file", "1280×720"],
    ["Vertical file", timeline.framing?.vertical==="fit" ? "720×1280, whole-recording fit with letterboxing" : "720×1280, focus-based portrait crop"],
  ];
  return `<article class="receipt"><p class="eyebrow">Export receipt</p><h3>${escapeHTML(state.project.studio.name)}</h3>${stale ? '<p class="receipt-warn">These files are from an earlier edit. Settings below describe the current saved timeline, not those files. Render again to update the receipt.</p>' : ""}<dl>${rows
    .map(
      ([term, value]) =>
        `<div><dt>${escapeHTML(term)}</dt><dd>${escapeHTML(value)}</dd></div>`,
    )
    .join("")}</dl><p class="field-note">The editor draft is not a pixel match. Render eases the zoom, paints the frame, and smooths a separate cursor track. Final output uses the saved ratio-specific fit/cover setting. Cover crops around focus; fit preserves the full recording with letterboxing. The draft does not reproduce that geometry or the closing treatment. Inspect both final films; surrounding content may be cropped.</p></article>`;
}
function renderExports() {
  const files = state.project?.exports || [];
  $("export-title").textContent = files.length
    ? "The files from the last successful render."
    : "Your finished formats.";
  $("export-description").textContent = files.length
    ? "Open each format. This receipt describes those files. The editor draft is not a pixel match of them."
    : "Make your edits, then render the landscape film, vertical film, still, and local share page. No rendered files are available.";
  $("export-count").textContent = files.length;
  $("export-receipt").innerHTML = receiptHTML(files);
  if (!files.length) {
    $("export-list").innerHTML =
      '<div class="export-placeholder">Your finished formats will appear here.<br><br>Make your edits, then choose <strong>Render</strong>.</div>';
    return;
  }
  const titles = {
    "landscape.mp4": "Landscape demo",
    "landscape.webm": "Landscape demo",
    "vertical.mp4": "Vertical demo",
    "vertical.webm": "Vertical demo",
    "thumbnail.png": "Thumbnail / still",
    "demo.gif": "Animated preview",
    "index.html": "Local share page",
    "captions.vtt": "Captions · VTT",
    "captions.srt": "Captions · SRT",
    "vertical-thumbnail.png": "Portrait thumbnail / still",
    "portrait.html": "Portrait share page",
  };
  $("export-list").innerHTML = files
    .map((file) => {
      const url = `/exports/${encodeURIComponent(state.project.studio.id)}/${encodeURIComponent(file.name)}`;
      const isVideo = /\.(mp4|webm|mov)$/i.test(file.name);
      const isImage = /\.(png|jpe?g|gif|webp)$/i.test(file.name);
      const preview = isVideo
        ? `<video controls playsinline preload="metadata" src="${url}"></video>`
        : isImage
          ? `<img loading="lazy" src="${url}" alt="${escapeHTML(titles[file.name] || file.name)}">`
          : '<span class="share-icon">↗</span>';
      const detail =
        file.width && file.height
          ? `${file.width} × ${file.height}`
          : file.name;
      return `<article class="export-card ${file.stale ? "stale" : ""}"><div class="export-preview">${preview}</div><div class="export-card-footer"><div><h3>${escapeHTML(titles[file.name] || file.name)}</h3><p>${escapeHTML(detail)}${file.stale ? " · From an earlier edit — render again" : ""}</p></div><a class="button small-button" href="${url}" target="_blank" rel="noopener">Open</a></div></article>`;
    })
    .join("");
}
async function startRender() {
  if (state.busy || state.rendering || !state.project) return;
  setBusy(true);
  try {
    await saveTimeline();
    const { jobId } = await api(`${projectURL()}/render`, { method: "POST" });
    state.rendering = true;
    progress("Rendering your demo", "Checking preserved media");
    let job;
    let failures = 0;
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      try {
        job = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
        failures = 0;
      } catch (error) {
        if (++failures >= 3)
          throw new Error(
            `Render status unavailable. The job may still be running; reopen this project to check outputs. ${error.message}`,
          );
        continue;
      }
      progress("Rendering your demo", job.progress || "Compositing frames…");
      if (job.status === "error")
        throw new Error(
          job.error ||
            "Rendering failed. Your original media and edits are safe.",
        );
      if (job.status === "done") break;
    }
    state.project = await api(projectURL());
    renderExports();
    switchView("exports");
    notify("Render complete. Open each format to inspect the final result.");
  } catch (error) {
    notify(error.message, true);
    showFailure("Render failed", error.message);
  } finally {
    state.rendering = false;
    setBusy(false);
  }
}
async function transcribeLocally() {
  if (state.busy || state.rendering || !state.project) return;
  setBusy(true);
  progress(
    "Transcribing locally",
    "Reading source audio on this computer. This may take a moment…",
  );
  try {
    if (state.dirty) await saveTimeline();
    const project = await api(`${projectURL()}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: state.project.studio.revision }),
    });
    loadProject(project);
    $("captions-section").open = true;
    // Caption rows are recreated by loadProject; keep controls locked until completion.
    setBusy(true);
    notify(
      project.timeline.captions.length
        ? "Local transcription complete. Review caption words and timing before rendering."
        : "No speech was detected. You can add captions manually.",
    );
  } catch (error) {
    notify(error.message, true);
  } finally {
    setBusy(false);
  }
}
function setInputMode(mode) {
  state.inputMode = mode;
  $("import-fields").classList.toggle("hidden", mode !== "import");
  $("capture-fields").classList.toggle("hidden", mode !== "capture");
  $("capture-url").required = mode === "capture";
  for (const tab of ["import", "capture"]) {
    $(`${tab}-tab`).classList.toggle("active", mode === tab);
    $(`${tab}-tab`).setAttribute("aria-pressed", String(mode === tab));
  }
  $("create-error").classList.add("hidden");
}
function openNewProject(mode = "import") {
  if (state.busy || state.rendering) return;
  setInputMode(mode);
  $("new-dialog").showModal();
  $("new-name").focus();
}
async function createProject(event) {
  event.preventDefault();
  if (state.busy || state.rendering) return;
  $("create-error").classList.add("hidden");
  try {
    if (!mayLeave()) return;
    const name = $("new-name").value.trim();
    if (!name) throw new Error("Give your demo a project name.");
    let payload;
    if (state.inputMode === "import") {
      const file = $("media-file").files[0];
      if (!file)
        throw new Error("Choose a recording before creating the project.");
      if (!file.size)
        throw new Error(
          "This recording is empty. Choose a playable video file.",
        );
      setBusy(true);
      progress(
        "Importing your recording",
        `Preserving the original media and creating your ${DISPLAY_NAMES.studio} project…`,
      );
      payload = await api("/api/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Filename": encodeURIComponent(file.name),
          "X-Project-Name": encodeURIComponent(name),
        },
        body: file,
      });
    } else {
      if (!$("flow-reviewed").checked)
        throw new Error(
          "Review the capture URL and steps, then confirm they are ready to run.",
        );
      let steps;
      try {
        steps = JSON.parse($("capture-steps").value);
      } catch {
        throw new Error(
          "Capture steps must be valid JSON. Check commas and quotation marks.",
        );
      }
      if (!Array.isArray(steps) || steps.length > 12)
        throw new Error(
          "Capture steps must be a JSON array of at most 12 actions.",
        );
      const url = new URL($("capture-url").value);
      if (!["http:", "https:"].includes(url.protocol))
        throw new Error("Enter a supported http:// or https:// web-app URL.");
      setBusy(true);
      progress(
        "Capturing your web flow",
        "Running the reviewed steps in an isolated browser session…",
      );
      payload = await api("/api/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, url: url.href, steps }),
      });
    }
    $("new-dialog").close();
    loadProject(payload);
    await refreshLibrary();
    notify("Your source is preserved. Shape your demo in the editor.");
  } catch (error) {
    $("create-error").textContent = error.message;
    $("create-error").classList.remove("hidden");
  } finally {
    setBusy(false);
  }
}

function showInspection(inspection) {
  $("inspection-image-wrap").classList.toggle("hidden",!inspection?.filename);
  if(inspection?.filename)$("inspection-image").src=`/inspection/${state.project.studio.id}/${inspection.filename}?v=${inspection.frameHash}`;
  $("inspection-status").textContent=inspection ? `${inspection.stale?'STALE':'INSPECTED_FRAME'} · ${inspection.ratio||''} · output ${((inspection.timeMs||0)/1000).toFixed(2)}s. Not a final-video receipt.` : 'No inspected frame.';
}
async function inspectCurrent(reviewCover=false){
 if(!state.project||state.busy||state.rendering)return;
 setBusy(true);progress('Inspecting final composition','Rendering or reusing the exact compositor output…');
 try{
  const timeMs=Math.round(Number($("inspect-time").value)*1000),ratio=$("inspect-ratio").value;
  if(reviewCover){state.project.timeline.coverTimeMs=timeMs;state.dirty=true;}
  if(state.dirty)await saveTimeline();
  const result=await api(`${projectURL()}/inspect`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.project.studio.revision,ratio,timeMs,reviewCover})});
  if(reviewCover){$("cover-download").href=`/inspection/${state.project.studio.id}/reviewed-cover.png?v=${result.frameHash}`;$("cover-download").classList.remove('hidden');notify('Cover reviewed from final composition. This is separate from a final-video receipt.');}
  else state.project.inspection=result;
  showInspection(result);
 }catch(e){notify(e.message,true);}finally{setBusy(false);}
}
function showSilence(){
 const batch=state.project.editing?.silence;$('silence-status').textContent=batch?`${batch.status} · ${batch.sourceIdentity.timelineRevision===state.project.studio.revision?'Current source evidence':'STALE: detect again'} · ${batch.warnings.join(', ')}`:'No detector evidence yet.';
 $('silence-proposals').innerHTML='';
 for(const proposal of batch?.proposals||[]){
  const row=document.createElement('fieldset');row.className='silence-row';row.dataset.observation=proposal.observationId;
  row.innerHTML=`<legend>${escapeHTML(proposal.evidenceKind)}</legend><p class="field-note">Source ${proposal.sourceStartMs/1000}–${proposal.sourceEndMs/1000}s · ${escapeHTML(proposal.reason)}${batch.reviewed[proposal.observationId]?' · reviewed '+escapeHTML(batch.reviewed[proposal.observationId].action):''}</p><button type="button" data-audition>Audition source interval</button><label>Decision<select data-silence-action><option>KEEP</option>${proposal.evidenceKind==='LOW_AMPLITUDE'?'<option>SHORTEN</option><option>REMOVE</option>':''}</select></label><label><input type="checkbox" data-silence-reviewed> I reviewed this decision</label><button type="button" data-silence-apply>Save reviewed decision</button>`;
  row.querySelector('[data-audition]').onclick=()=>{state.auditionEnd=proposal.sourceEndMs;video.currentTime=proposal.sourceStartMs/1000;video.play().catch(e=>notify(e.message,true));};
  row.querySelector('[data-silence-apply]').onclick=()=>silenceAction('review',{observationId:proposal.observationId,action:row.querySelector('select').value,reviewed:row.querySelector('input').checked});
  $('silence-proposals').append(row);
 }
}
async function silenceAction(action,data={}){if(!state.project||state.busy)return;setBusy(true);try{if(state.dirty)throw Error('Save edits before silence review.');loadProject(await api(`${projectURL()}/silence-${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.project.studio.revision,...data})}));notify('Silence evidence/review saved. No automatic cuts.');}catch(e){notify(e.message,true);}finally{setBusy(false);}}
$('detect-silence').onclick=()=>silenceAction('detect');
function showTranscriptProposal(){const p=state.project.editing?.transcriptProposal;state.transcriptProposal=p;$('transcript-proposal').textContent=p?`Review “${p.displayText}”: source ${p.sourceStartMs/1000}–${p.sourceEndMs/1000}s · proposed at revision ${p.timelineRevision}${p.timelineRevision!==state.project.studio.revision?' · STALE':''}`:'No word cut proposal.';$('transcript-reviewed').checked=false;$('aligned-words').textContent='';$('word-first').replaceChildren();$('word-last').replaceChildren();$('word-status').textContent='Load current aligned words to make a selection.';}
$('load-transcript-words').onclick=async()=>{try{const result=await api(`${projectURL()}/transcript-words`);$('word-status').textContent=result.unavailable||'ASR draft: select a contiguous first/last word range and audition. Text is not verified.';$('aligned-words').textContent=result.words.map(w=>w.text).join('');for(const id of ['word-first','word-last'])$(id).innerHTML=result.words.map(w=>`<option value="${escapeHTML(w.id)}">${escapeHTML(w.text.trim())} · ${(w.startMs/1000).toFixed(2)}s</option>`).join('');}catch(e){notify(e.message,true);}};
async function transcriptAction(action){if(!state.project||state.busy)return;setBusy(true);try{if(state.dirty)throw Error('Save edits before transcript review.');const proposal=state.transcriptProposal;const data=action==='propose'?{startWordId:$('word-first').value,endWordId:$('word-last').value}:{proposalId:proposal?.proposalId,action,reviewed:$('transcript-reviewed').checked};const project=await api(`${projectURL()}/transcript-${action==='propose'?'propose':'review'}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.project.studio.revision,...data})});loadProject(project);notify(action==='accept'?'Word cut saved. Render and inspect the revised timeline.':'Transcript review saved.');}catch(e){notify(e.message,true);}finally{setBusy(false);}}
$('propose-transcript-cut').onclick=()=>transcriptAction('propose');for(const action of ['accept','reject'])$(`${action}-transcript`).onclick=()=>transcriptAction(action);
$('audition-transcript').onclick=()=>{const p=state.transcriptProposal;if(!p)return;state.auditionEnd=p.sourceEndMs;video.currentTime=p.sourceStartMs/1000;video.play().catch(e=>notify(e.message,true));};
function collectFocusBlocks(){return [...$('focus-block-list').querySelectorAll('[data-focus-id]')].map(row=>{
 const value=k=>row.querySelector(`[data-f="${k}"]`).value;
 const block={id:row.dataset.focusId,sourceStartMs:Math.round(Number(value('start'))*1000),sourceEndMs:Math.round(Number(value('end'))*1000),target:{x:Number(value('x')),y:Number(value('y'))},zoom:Number(value('zoom')),enabled:row.querySelector('[data-f="enabled"]').checked,easing:value('easing'),cursorPolicy:value('cursor')};
 if(row.querySelector('[data-f="portrait"]').checked)block.ratioOverrides={'9:16':{target:{x:Number(value('px')),y:Number(value('py'))},zoom:Number(value('pz'))}};
 return block;
});}
function renderFocusBlocks(){
 const input=(key,label,value,min,max)=>`<label>${label}<input data-f="${key}" type="number" step="0.001" min="${min}" max="${max}" value="${value}"></label>`;
 $('focus-block-list').innerHTML=(state.project.timeline.focusBlocks||[]).map((b,i)=>`<fieldset data-focus-id="${escapeHTML(b.id)}"><legend>Focus ${i+1}</legend><label><input type="checkbox" data-f="enabled" ${b.enabled?'checked':''}> Enabled</label><div class="two-columns">${input('start','Source start (s)',b.sourceStartMs/1000,0,120)}${input('end','Source end (s)',b.sourceEndMs/1000,0,120)}${input('x','Target X',b.target.x,0,1)}${input('y','Target Y',b.target.y,0,1)}</div>${input('zoom','Zoom',b.zoom,1,2)}<label>Easing<select data-f="easing"><option value="easeInOutCubic" ${b.easing==='easeInOutCubic'?'selected':''}>Smooth</option><option value="linear" ${b.easing==='linear'?'selected':''}>Linear</option></select></label><label>Cursor<select data-f="cursor">${['preserve','on','off','smooth','raw'].map(v=>`<option ${b.cursorPolicy===v?'selected':''}>${v}</option>`).join('')}</select></label><label><input data-f="portrait" type="checkbox" ${b.ratioOverrides?.['9:16']?'checked':''}> Separate portrait target</label><div class="two-columns">${input('px','Portrait X',b.ratioOverrides?.['9:16']?.target?.x??b.target.x,0,1)}${input('py','Portrait Y',b.ratioOverrides?.['9:16']?.target?.y??b.target.y,0,1)}</div>${input('pz','Portrait zoom',b.ratioOverrides?.['9:16']?.zoom??b.zoom,1,2)}<button data-focus-delete="${i}" type="button">Delete focus block</button></fieldset>`).join('');
 $('focus-block-list').querySelectorAll('[data-focus-delete]').forEach(b=>b.onclick=()=>{state.project.timeline=collectTimeline();state.project.timeline.focusBlocks.splice(Number(b.dataset.focusDelete),1);renderFocusBlocks();markDirty();applyPreview();});
}
$('add-focus-block').onclick=()=>{state.project.timeline=collectTimeline();const blocks=state.project.timeline.focusBlocks,start=blocks.length?Math.max(...blocks.map(b=>b.sourceEndMs)):state.project.timeline.trim.startMs,end=Math.min(start+1500,state.project.studio.asset.durationMs);if(end<=start)return notify('Edit an existing interval to make room for another block.',true);blocks.push({id:crypto.randomUUID(),sourceStartMs:start,sourceEndMs:end,target:{x:.5,y:.5},zoom:1.35,easing:'easeInOutCubic',cursorPolicy:'preserve',enabled:true});renderFocusBlocks();markDirty();};
$('propose-focus').onclick=async()=>{try{if(state.dirty)throw Error('Save edits before generating proposals.');const result=await api(`${projectURL()}/focus-proposals`);$('focus-proposals').textContent=result.proposals.length?'Review each proposal; accepting adds a draft block. Save to persist.':'No qualifying captured click evidence. Add a manual block.';for(const proposal of result.proposals){const button=document.createElement('button');button.textContent=`Accept reviewed click focus ${proposal.block.sourceStartMs/1000}–${proposal.block.sourceEndMs/1000}s (${proposal.evidence.clickCount} clicks)`;button.onclick=()=>{if(result.revision!==state.project.studio.revision)return notify('Proposal stale; regenerate.',true);state.project.timeline=collectTimeline();state.project.timeline.focusBlocks.push(proposal.block);renderFocusBlocks();markDirty();button.disabled=true;};$('focus-proposals').append(button);}}catch(e){notify(e.message,true);}};
for(const id of ['cut-start','cut-end'])$(id).addEventListener('input',()=>{$('cut-reviewed').checked=false;});
$('audition-cut').addEventListener('click',()=>{state.auditionEnd=Number($('cut-end').value)*1000;video.currentTime=Number($('cut-start').value);video.play().catch(e=>notify(e.message,true));});
for(const action of ['remove','restore'])$(`${action}-cut`).addEventListener('click',async()=>{
  if(!state.project||state.busy||state.rendering)return;
  if(!$('cut-reviewed').checked)return notify('Review and confirm the original interval first.',true);
  setBusy(true);try{if(state.dirty)await saveTimeline();const project=await api(`${projectURL()}/cut`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.project.studio.revision,action,startMs:Math.round(Number($('cut-start').value)*1000),endMs:Math.round(Number($('cut-end').value)*1000),reviewed:true})});loadProject(project);$('cut-reviewed').checked=false;notify('Timeline updated. Prior outputs are stale; render and inspect again.');}catch(e){notify(e.message,true);}finally{setBusy(false);}
});
$("inspect-frame").addEventListener('click',()=>inspectCurrent(false));
$("review-cover").addEventListener('click',()=>inspectCurrent(true));
$("safe-guides").addEventListener('change',()=>$("inspection-image-wrap").classList.toggle('guides-visible',$("safe-guides").checked));
for(const id of ['inspect-time','inspect-ratio'])$(id).addEventListener('input',()=>{$("cover-download").classList.add('hidden');$("inspection-status").textContent='Selection changed; inspect again to review this time and ratio.';});
$("recover-presentation").addEventListener('click',async()=>{if(!state.project||state.busy||state.rendering)return;setBusy(true);try{const project=await api(`${projectURL()}/recover`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.project.studio.revision})});loadProject(project);notify('Previous saved presentation recovered as a new revision.');}catch(e){notify(e.message,true);}finally{setBusy(false);}});
$("import-subtitles").addEventListener('click',async()=>{
 if(!state.project||state.busy||state.rendering)return;const file=$("subtitle-file").files[0];
 if(!file||file.size>100000){notify('Choose an SRT/VTT file under 100 KB.',true);return;}
 setBusy(true);try{if(state.dirty)throw Error('Save presentation changes before importing captions.');const format=file.name.split('.').pop().toLowerCase();const project=await api(`${projectURL()}/subtitles`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.project.studio.revision,format,text:await file.text()})});loadProject(project);$("captions-section").open=true;notify('Captions imported. Review text and timing; word alignment is unavailable.');}catch(e){notify(e.message,true);}finally{setBusy(false);}
});

$("new-project").addEventListener("click", () => openNewProject());
$("empty-import").addEventListener("click", () => openNewProject("import"));
$("empty-capture").addEventListener("click", () => openNewProject("capture"));
$("close-dialog").addEventListener("click", () => $("new-dialog").close());
$("new-dialog").addEventListener("cancel", (event) => {
  if (state.busy) event.preventDefault();
});
$("import-tab").addEventListener("click", () => setInputMode("import"));
$("capture-tab").addEventListener("click", () => setInputMode("capture"));
$("capture-url").addEventListener("input", () => {
  $("flow-reviewed").checked = false;
});
$("capture-steps").addEventListener("input", () => {
  $("flow-reviewed").checked = false;
});
$("create-form").addEventListener("submit", createProject);
$("media-file").addEventListener("change", () => {
  const file = $("media-file").files[0];
  $("file-label").textContent = file ? file.name : "Choose your recording";
  if (file && !$("new-name").value)
    $("new-name").value = file.name
      .replace(/\.[^.]+$/, "")
      .replace(/[-_]/g, " ");
});
$("editor-tab").addEventListener("click", () => switchView("editor"));
$("exports-tab").addEventListener("click", () => switchView("exports"));
$("dismiss-notification").addEventListener("click", () =>
  $("notification").classList.add("hidden"),
);
$("save").addEventListener("click", async () => {
  setBusy(true);
  try {
    await saveTimeline();
    notify("Timeline saved locally.");
  } catch (error) {
    notify(error.message, true);
  } finally {
    setBusy(false);
  }
});
$("render").addEventListener("click", startRender);
$("transcribe").addEventListener("click", transcribeLocally);
document.querySelector(".inspector").addEventListener("input", (event) => {
  if(event.target.closest("#silence-section"))return;
  if(["inspect-ratio","inspect-time","safe-guides","subtitle-file","cut-start","cut-end","cut-reviewed","word-first","word-last","transcript-reviewed"].includes(event.target.id))return;
  if (state.project) {
    markDirty();
    applyPreview();
  }
});
for (const button of document.querySelectorAll("[data-theme]"))
  button.addEventListener("click", () => {
    if (!state.project) return;
    document
      .querySelectorAll("[data-theme]")
      .forEach((item) => item.classList.toggle("selected", item === button));
    markDirty();
    applyPreview();
  });
$("add-caption").addEventListener("click", () => {
  const timeline = collectTimeline();
  if (timeline.captions.length >= 40) {
    notify(`A ${DISPLAY_NAMES.studio} timeline supports up to 40 captions.`, true);
    return;
  }
  const startMs = Math.max(
    timeline.trim.startMs,
    Math.min(Math.round(video.currentTime * 1000), timeline.trim.endMs - 100),
  );
  timeline.captions.push({
    startMs,
    endMs: Math.min(startMs + 2500, timeline.trim.endMs),
    text: "Your caption here",
  });
  state.project.timeline = timeline;
  renderCaptionEditor();
  markDirty();
  applyPreview();
});
for (const orientation of ["landscape", "vertical"])
  $(`${orientation}-preview`).addEventListener("click", () => {
    const vertical = orientation === "vertical";
    $("composition").classList.toggle("vertical", vertical);
    $("stage").classList.toggle("vertical", vertical);
    for (const item of ["landscape", "vertical"]) {
      $(`${item}-preview`).classList.toggle("active", item === orientation);
      $(`${item}-preview`).setAttribute(
        "aria-pressed",
        String(item === orientation),
      );
    }
    if (state.project) $("preview-truth").textContent = previewTruth();
  });
function setFinish(finish) {
  state.finish = finish;
  const stage = $("stage");
  stage.classList.remove("finish-raw", "finish-split", "finish-draft");
  stage.classList.add(`finish-${finish}`);
  for (const name of ["raw", "split", "draft"]) {
    const button = $(`finish-${name}`);
    const on = name === finish;
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", String(on));
  }
  $("finish-label").textContent =
    finish === "raw"
      ? "Raw recording"
      : finish === "split"
        ? "Raw beside draft"
        : "Editor draft";
  if (finish === "split" && video.src) {
    if (compareVideo.src !== video.src) {
      compareVideo.src = video.src;
      compareVideo.load();
    }
    if (compareVideo.readyState >= 1)
      compareVideo.currentTime = video.currentTime;
  } else compareVideo.pause();
  if (state.project) applyPreview();
}
for (const name of ["raw", "split", "draft"])
  $(`finish-${name}`).addEventListener("click", () => setFinish(name));
for (const button of document.querySelectorAll("#step-rail [data-step]"))
  button.addEventListener("click", () => {
    const step = button.dataset.step;
    if (step === "exports") {
      switchView("exports");
      return;
    }
    if (state.project) switchView("editor");
    markStep(step);
    const section = $(`${step}-section`);
    if (section) {
      section.open = true;
      section.scrollIntoView({ block: "nearest" });
    }
  });
$("dismiss-progress").addEventListener("click", () => {
  $("progress-panel").classList.add("hidden");
  $("progress-panel").classList.remove("failed");
});
$("play").addEventListener("click", async () => {
  if (!state.project) return;
  if (!video.paused) {
    video.pause();
    return;
  }
  const timeline = collectTimeline();
  if (
    video.currentTime * 1000 < timeline.trim.startMs ||
    video.currentTime * 1000 >= timeline.trim.endMs - 50
  )
    video.currentTime = timeline.trim.startMs / 1000;
  try {
    await video.play();
  } catch (error) {
    notify(`Preview could not play: ${error.message}`, true);
  }
});
$("seek").addEventListener("input", () => {
  video.currentTime = outputToSourceMs(timelineRanges(collectTimeline()),Number($("seek").value)) / 1000;
  updatePlayback();
});
$("mute").addEventListener("click", () => {
  video.muted = !video.muted;
  $("mute").textContent = video.muted ? "♩" : "♫";
  $("mute").setAttribute(
    "aria-label",
    video.muted ? "Unmute preview" : "Mute preview",
  );
});
video.addEventListener("loadedmetadata", () => {
  if (state.project)
    video.currentTime = state.project.timeline.trim.startMs / 1000;
  updatePlayback();
});
video.addEventListener("play", () => {
  $("play").textContent = "Ⅱ";
  $("play").setAttribute("aria-label", "Pause preview");
  if (state.finish === "split") compareVideo.play().catch(() => {});
});
video.addEventListener("pause", () => {
  $("play").textContent = "▶";
  $("play").setAttribute("aria-label", "Play preview");
  compareVideo.pause();
});
video.addEventListener("timeupdate", () => {
  if(state.auditionEnd!==undefined){if(video.currentTime*1000>=state.auditionEnd){video.pause();delete state.auditionEnd;}return;}
  if(state.project&&!video.paused){
    const set=timelineRanges(collectTimeline()),ms=Math.round(video.currentTime*1000);
    if(sourceToOutputMs(set,Math.min(ms,set.sourceDurationMs))===null){
      const next=set.ranges.find(r=>r.startMs>ms);if(next)video.currentTime=next.startMs/1000;else video.pause();
    }
  }
  updatePlayback();
});
video.addEventListener("error", () => {
  if (state.project)
    notify(
      "The source video could not be previewed in this browser. Check the media file or try MP4/WebM.",
      true,
    );
});
window.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const tag = event.target?.tagName;
  if (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "BUTTON" ||
    event.target?.isContentEditable ||
    $("new-dialog").open
  )
    return;
  if (!state.project) return;
  if (event.key === " ") {
    event.preventDefault();
    $("play").click();
  } else if (event.key === "1") $("landscape-preview").click();
  else if (event.key === "2") $("vertical-preview").click();
  else if (event.key === "b" || event.key === "B") {
    const order = ["raw", "split", "draft"];
    setFinish(order[(order.indexOf(state.finish) + 1) % order.length]);
  } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const step = event.shiftKey ? 2 : 0.5;
    const timeline = collectTimeline();
    const next = Math.min(
      timeline.trim.endMs / 1000,
      Math.max(timeline.trim.startMs / 1000, video.currentTime + direction * step),
    );
    video.currentTime = next;
    updatePlayback();
  }
});
window.addEventListener("resize", () => {
  if (state.project) paintTimeline(collectTimeline());
});
window.addEventListener("beforeunload", (event) => {
  if (state.dirty || state.busy) {
    event.preventDefault();
    event.returnValue = "";
  }
});
async function init() {
  try {
    const config = await api("/api/config");
    state.token = config.csrfToken;
    await refreshLibrary();
    const lastId = localStorage.getItem("launchforge.lastProject");
    if (
      lastId &&
      state.projects.some((item) => (item.studio || item).id === lastId)
    )
      await openProject(lastId);
  } catch (error) {
    notify(
      `${DISPLAY_NAMES.studio} could not connect: ${error.message} Start the local server and reload.`,
      true,
    );
    $("project-list").innerHTML =
      `<p class="project-empty">Workspace unavailable. Check the local ${escapeHTML(DISPLAY_NAMES.studio)} server.</p>`;
  }
}
init();
