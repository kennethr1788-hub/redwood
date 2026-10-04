import { z } from "zod";

const seconds = z.number().finite().nonnegative().max(121);
export const RawSegments = z.array(z.object({
  start: seconds,
  end: seconds,
  text: z.string().max(10000),
  words: z.array(z.object({
    start: seconds,
    end: seconds,
    word: z.string().max(10000),
  }).strict()).max(2000).optional(),
}).strict()).max(200);

export const cleanText = (text) => text
  .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

export function validateCaptions(captions, durationMs = 120000) {
  if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 120000)
    throw Error("Invalid source duration for captions.");
  if (!Array.isArray(captions) || captions.length > 40)
    throw Error("Transcript needs more than 40 captions. Use a shorter source or edit imported captions.");
  let previousEnd = 0;
  return captions.map((cue) => {
    if (!cue || !Number.isInteger(cue.startMs) || !Number.isInteger(cue.endMs) ||
        cue.startMs < previousEnd || cue.endMs <= cue.startMs || cue.endMs > durationMs)
      throw Error("Invalid or overlapping caption times; require ordered source milliseconds.");
    if (typeof cue.text !== "string" || !cleanText(cue.text) || cue.text.length > 180)
      throw Error("Caption text must contain 1–180 characters.");
    previousEnd = cue.endMs;
    return { startMs: cue.startMs, endMs: cue.endMs, text: cleanText(cue.text) };
  });
}

/** Split at whitespace; never truncate. Keep pathological long tokens readable too. */
export function splitText(text, limit = 84) {
  if (!Number.isInteger(limit) || limit < 2 || limit > 180) throw Error("Invalid caption line limit.");
  const chunks = [];
  let rest = cleanText(text);
  while (rest.length) {
    let end = Math.min(limit, rest.length);
    if (rest.length > limit) {
      const space = rest.lastIndexOf(" ", limit);
      if (space > 0) end = space;
      // Do not cut a UTF-16 surrogate pair in half.
      else if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
    }
    chunks.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  return chunks;
}

/** Balanced subtitle lines. Renderer retains its own pixel-based wrapping. */
export function captionLines(text) {
  const value = cleanText(text);
  if (value.length <= 42) return [value];
  const breaks = [...value.matchAll(/ /g)].map((m) => m.index)
    .filter((i) => i <= 42 && value.length - i - 1 <= 42);
  if (breaks.length) {
    const middle = breaks.reduce((a, b) =>
      Math.abs(a - value.length / 2) <= Math.abs(b - value.length / 2) ? a : b);
    return [value.slice(0, middle), value.slice(middle + 1)];
  }
  return splitText(value, 42);
}

function interpolate(text, startMs, endMs) {
  // Without usable word alignment, timing is explicitly approximate.
  const targetParts = Math.max(1, Math.ceil((endMs - startMs) / 6000));
  const chunks = splitText(text, Math.min(84, Math.max(12, Math.ceil(text.length / targetParts))));
  if (endMs - startMs < chunks.length) throw Error("ASR segment is too short for its text.");
  const total = chunks.reduce((n, s) => n + s.length, 0);
  let offset = 0, previous = startMs;
  return chunks.map((chunk, i) => {
    offset += chunk.length;
    const end = i === chunks.length - 1 ? endMs : Math.max(previous + 1,
      Math.min(endMs - (chunks.length - i - 1), Math.round(startMs + (endMs - startMs) * offset / total)));
    const cue = { startMs: previous, endMs: end, text: chunk };
    previous = end;
    return cue;
  });
}

function alignedWords(segment, startMs, endMs) {
  if (!segment.words?.length) return null;
  // A word alignment may omit text or contain zero/reversed times. Preserve the
  // complete segment text with interpolated timing instead of dropping words.
  if (cleanText(segment.words.map((w) => w.word).join("")) !== cleanText(segment.text)) return null;
  const words = [];
  let previous = startMs;
  for (const w of segment.words) {
    const start = Math.max(startMs, Math.round(w.start * 1000));
    const end = Math.min(endMs, Math.round(w.end * 1000));
    if (start < previous || end <= start || !cleanText(w.word)) return null;
    words.push({ startMs: start, endMs: end, text: w.word });
    previous = end;
  }
  return words;
}

export function captionsFromSegments(segments, durationMs) {
  validateCaptions([], durationMs);
  const parsed = RawSegments.parse(segments);
  const captions = [];
  let previousEnd = 0;
  for (const segment of parsed) {
    if (segment.end < segment.start || segment.start * 1000 < previousEnd - 100)
      throw Error("ASR returned invalid or overlapping segment times.");
    const startMs = Math.max(previousEnd, Math.min(durationMs, Math.round(segment.start * 1000)));
    const endMs = Math.min(durationMs, Math.round(segment.end * 1000));
    const text = cleanText(segment.text);
    if (!text || endMs <= startMs) continue;
    const words = alignedWords(segment, startMs, endMs);
    if (!words) captions.push(...interpolate(text, startMs, endMs));
    else {
      let group;
      const flush = () => {
        if (group) captions.push(...interpolate(group.text, group.startMs, group.endMs));
        group = undefined;
      };
      for (const word of words) {
        if (group && (cleanText(group.text + word.text).length > 84 ||
            word.endMs - group.startMs > 6000 || word.startMs - group.endMs >= 700 ||
            (/[.!?]$/.test(group.text) && group.text.length >= 32))) flush();
        group = group ? { ...group, endMs: word.endMs, text: group.text + word.text } : { ...word };
      }
      flush();
    }
    previousEnd = endMs;
  }
  return validateCaptions(captions, durationMs);
}

/** Gaps are review candidates, NOT proof of silence and never edit instructions. */
export function silenceCandidates(captions, durationMs, minimumMs = 700) {
  const cues = validateCaptions(captions, durationMs);
  if (!Number.isInteger(minimumMs) || minimumMs < 1) throw Error("Invalid silence threshold.");
  const gaps = [];
  let end = 0;
  for (const cue of [...cues, { startMs: durationMs, endMs: durationMs }]) {
    if (cue.startMs - end >= minimumMs)
      gaps.push({ startMs: end, endMs: cue.startMs, reason: "caption-gap", reviewRequired: true });
    end = cue.endMs;
  }
  return gaps;
}
