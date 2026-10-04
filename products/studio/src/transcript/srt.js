import {outputCaptions} from '../timeline/project.js';
import { captionsFromSegments, captionLines, cleanText, validateCaptions } from "./captions.js";

function timestamp(value, vtt = false) {
  const m = (vtt ? /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/ : /^(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})$/).exec(value);
  if (!m || Number(m[2]) > 59 || Number(m[3]) > 59) throw Error("Invalid subtitle timestamp");
  return Number(m[1] || 0) * 3600000 + Number(m[2]) * 60000 + Number(m[3]) * 1000 + Number(m[4]);
}

function plainText(value) {
  // Strip source styling first, then decode one layer. Escaped literal markup
  // remains literal text; it is never evaluated as HTML or recursively decoded.
  return value.replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, (entity, key) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    if (!key.startsWith("#")) return named[key.toLowerCase()];
    const code = key[1].toLowerCase() === "x" ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity;
  });
}

function parse(text, vtt, durationMs) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 100000)
    throw Error("Subtitle file must be under 100 KB");
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) throw Error("Subtitle file contains no captions.");
  const blocks = normalized.split(/\n[ \t]*\n/);
  if (vtt) {
    if (!/^WEBVTT(?:[ \t].*)?(?:\n.*)*$/.test(blocks[0])) throw Error("VTT must begin with WEBVTT and a blank line.");
    blocks.shift();
  }
  const segments = [];
  let previousEnd = 0;
  for (const block of blocks) {
    if (vtt && /^NOTE(?:[ \t\n]|$)/.test(block)) continue;
    const lines = block.split("\n");
    if ((vtt && !lines[0].includes("-->")) || (!vtt && /^\d+$/.test(lines[0]))) lines.shift();
    const m = /^(\S+)\s+-->\s+(\S+)(?:[ \t]+(.*))?$/.exec(lines.shift() || "");
    if (!m || (!vtt && m[3])) throw Error("Subtitle block needs start --> end");
    const startMs = timestamp(m[1], vtt), endMs = timestamp(m[2], vtt);
    if (endMs <= startMs || startMs < previousEnd || endMs > durationMs)
      throw Error("Invalid or overlapping subtitle times; captions must fit the source duration.");
    const content = cleanText(plainText(lines.join(" ")));
    if (!content) throw Error("Subtitle cue contains no text.");
    segments.push({ start: startMs / 1000, end: endMs / 1000, text: content });
    previousEnd = endMs;
  }
  if (!segments.length) throw Error("Subtitle file contains no captions.");
  return captionsFromSegments(segments, durationMs);
}

/** Existing Studio CLI imports through this function; no model or network needed. */
export function parseSrt(text, durationMs = 120000) { return parse(text, false, durationMs); }
/** Plain-text WebVTT import; positioning is ignored, rich STYLE/REGION unsupported. */
export function parseVtt(text, durationMs = 120000) { return parse(text, true, durationMs); }

function time(ms, vtt) {
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}${vtt ? "." : ","}${String(ms % 1000).padStart(3, "0")}`;
}

function serialize(captions, { trim, rangeSet, durationMs = rangeSet?.sourceDurationMs ?? 120000 } = {}, vtt) {
  const cues = validateCaptions(captions, durationMs);
  const start = trim?.startMs ?? 0, end = trim?.endMs ?? durationMs;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > durationMs)
    throw Error("Invalid subtitle export trim.");
  const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const mapped = outputCaptions({captions:cues,trim:{startMs:start,endMs:end},rangeSet});
  const output = mapped.map((c, i) =>
    `${i + 1}\n${time(c.startMs, vtt)} --> ${time(c.endMs, vtt)}\n${captionLines(c.text).map(escape).join("\n")}\n`);
  return (vtt ? "WEBVTT\n\n" : "") + output.join("\n");
}

export const serializeSrt = (captions, options) => serialize(captions, options, false);
export const serializeVtt = (captions, options) => serialize(captions, options, true);
