import {validateFocusBlocks} from '../focus/blocks.js';
import { z } from "zod";
import {timelineRanges,retainedDurationMs} from '../timeline/project.js';
const ms = z.number().int().nonnegative().max(120000);
export const Timeline = z
  .object({
    schemaVersion: z.union([z.literal(1),z.literal(2)]),
    rangeSet: z.unknown().optional(),
    focusBlocks: z.array(z.unknown()).max(64).default([]),
    trim: z.object({ startMs: ms, endMs: ms }).strict(),
    title: z.string().max(100),
    subtitle: z.string().max(160),
    theme: z.enum(["aurora", "midnight", "ember"]),
    zoom: z.number().min(1).max(2),
    focus: z
      .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
      .strict(),
    captions: z
      .array(
        z
          .object({ startMs: ms, endMs: ms, text: z.string().min(1).max(180) })
          .strict(),
      )
      .max(40),
    cursor: z.boolean(),
    framing: z.object({landscape:z.enum(["fit","cover"]),vertical:z.enum(["fit","cover"])}).strict().default({landscape:"cover",vertical:"cover"}),
    coverTimeMs: ms.nullable().default(null),
  })
  .strict()
  .superRefine((t, c) => {
    if (t.trim.endMs - t.trim.startMs < 500)
      c.addIssue({
        code: "custom",
        message: "Trim must retain at least 0.5 seconds",
      });
    for (const s of t.captions)
      if (s.endMs <= s.startMs)
        c.addIssue({
          code: "custom",
          message: "Caption end must follow start",
        });
  });
export const Studio = z
  .object({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    name: z.string().min(1).max(80),
    createdAt: z.iso.datetime(),
    asset: z
      .object({
        path: z.string().regex(/^media\/original\.(mp4|mov|webm|mkv)$/),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        width: z.number().int().positive().max(7680),
        height: z.number().int().positive().max(4320),
        durationMs: ms.positive(),
        hasAudio: z.boolean(),
      })
      .strict(),
    input: z
      .object({
        kind: z.enum(["import", "url"]),
        url: z.string().max(2048).optional(),
      })
      .strict(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export function validateTimeline(value, studio) {
  const t = Timeline.parse(value);
  t.rangeSet=timelineRanges(t,studio.asset.durationMs);
  if(t.rangeSet.sourceDurationMs!==studio.asset.durationMs)throw Error("RangeSet source duration mismatch");
  if(t.trim.startMs!==t.rangeSet.ranges[0].startMs || t.trim.endMs!==t.rangeSet.ranges.at(-1).endMs)throw Error("Trim must match retained range bounds");
  t.focusBlocks=validateFocusBlocks(t.focusBlocks,{sourceDurationMs:studio.asset.durationMs});
  t.schemaVersion=2;
  if(retainedDurationMs(t.rangeSet)<500)throw Error("Retain at least 0.5 seconds");
  if(t.coverTimeMs!==null && t.coverTimeMs >= retainedDurationMs(t.rangeSet))throw Error("Cover time must be within output duration");
  if (t.trim.endMs > studio.asset.durationMs)
    throw Error("Trim exceeds source duration");
  if (t.captions.some((c) => c.endMs > studio.asset.durationMs))
    throw Error("Caption exceeds source duration");
  return t;
}
export function defaultTimeline(studio) {
  return {
    schemaVersion: 1,
    trim: { startMs: 0, endMs: studio.asset.durationMs },
    title: studio.name,
    subtitle: "Make every interaction count.",
    theme: "aurora",
    zoom: 1.15,
    focus: { x: 0.5, y: 0.5 },
    captions: [],
    cursor: studio.input.kind === "url",
  };
}
export const Event = z
  .object({
    type: z.enum(["move", "click", "scroll", "viewport"]),
    timeMs: ms,
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    deltaY: z.number().finite().optional(),
  })
  .strict();
