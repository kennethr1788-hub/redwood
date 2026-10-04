import { DISPLAY_NAMES } from "../../../../launcher/src/display-names.js";
import { access, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { binary, run } from "../core/media.js";
import { Studio, validateTimeline } from "../core/schema.js";

import { RawSegments, captionsFromSegments, silenceCandidates } from "./captions.js";
export { captionsFromSegments, silenceCandidates } from "./captions.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const script = fileURLToPath(new URL("./transcribe.py", import.meta.url));
const Provenance = z
  .object({
    engine: z.literal("faster-whisper"),
    versions: z
      .object({
        "faster-whisper": z.literal("1.2.1"),
        ctranslate2: z.string().max(30),
        av: z.string().max(30),
        numpy: z.string().max(30),
      })
      .strict(),
    model: z.literal("Systran/faster-whisper-small"),
    revision: z.literal("536b0662742c02347bc0e980a01041f333bce120"),
    modelSha256: z.literal(
      "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671",
    ),
    settings: z
      .object({
        device: z.literal("cpu"),
        computeType: z.literal("int8"),
        cpuThreads: z.literal(4),
        numWorkers: z.literal(1),
        beamSize: z.literal(1),
        language: z.literal("en"),
        vadFilter: z.literal(false),
        wordTimestamps: z.literal(true).optional(),
      })
      .strict(),
    offline: z.literal(true),
  })
  .strict();
const RawTranscript = z
  .object({
    schemaVersion: z.literal(1),
    segments: RawSegments,
    language: z.string().min(1).max(20),
    durationSeconds: z.number().positive().max(120.1),
    inferenceSeconds: z.number().nonnegative().max(300),
    provenance: Provenance,
  })
  .strict();

export async function transcribeProject({ projectDir, studio, timeline }) {
  const source = Studio.parse(studio);
  validateTimeline(timeline, source);
  if (!source.asset.hasAudio)
    throw Error(
      "This recording has no audio track. Import a recording with speech or enter captions manually.",
    );
  const python = path.resolve(
    process.env.STUDIO_PYTHON || path.join(root, ".tools/venv/bin/python"),
  );
  const model = path.resolve(
    process.env.STUDIO_WHISPER_MODEL || path.join(root, ".tools/model-small"),
  );
  try {
    await access(python, constants.X_OK);
    if (!(await stat(model)).isDirectory()) throw Error();
  } catch {
    throw Error(
      `Local transcription is not configured. Set STUDIO_PYTHON and STUDIO_WHISPER_MODEL to the qualified existing Python environment and small-model directory. ${DISPLAY_NAMES.studio} never downloads them automatically.`,
    );
  }
  const canonicalProject = await realpath(projectDir);
  let media;
  try {
    media = await realpath(path.join(canonicalProject, source.asset.path));
    if (!media.startsWith(canonicalProject + path.sep) || !(await stat(media)).isFile())
      throw Error(`Source media must be a file inside the ${DISPLAY_NAMES.studio} project.`);
  } catch (cause) {
    throw Error("Source media is missing or unreadable. Restore or re-import the recording before transcribing.", { cause });
  }
  const temp = await mkdtemp(path.join(canonicalProject, ".asr-"));
  try {
    const wav = path.join(temp, "speech.wav");
    try {
      await run(
        binary("ffmpeg"),
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-protocol_whitelist",
          "file,pipe",
          "-i",
          media,
          "-map",
          "0:a:0",
          "-vn",
          "-t",
          String(source.asset.durationMs / 1000),
          "-ac",
          "1",
          "-ar",
          "16000",
          "-c:a",
          "pcm_s16le",
          wav,
        ],
        { timeout: 30000 },
      );
    } catch (cause) {
      throw Error("Cannot read the recording's audio. Check the media tools and import a playable recording with an audio track. Existing captions were left unchanged.", { cause });
    }
    const args = [python, "-I", "-B", script, model, wav];
    const command =
      process.platform === "darwin" ? "/usr/bin/sandbox-exec" : python;
    const argv =
      process.platform === "darwin"
        ? ["-p", "(version 1) (allow default) (deny network*)", ...args]
        : args.slice(1);
    let transcript;
    try {
      transcript = RawTranscript.parse(
        JSON.parse(
          await run(command, argv, { timeout: 180000, maxBytes: 512 * 1024 }),
        ),
      );
    } catch (cause) {
      throw Error("Local transcription is unavailable or returned invalid data. Check the qualified faster-whisper 1.2.1 environment and small-model files. You can import SRT or enter captions manually; existing captions were left unchanged.", { cause });
    }
    const captions = captionsFromSegments(
      transcript.segments,
      source.asset.durationMs,
    );
    validateTimeline({ ...timeline, captions }, source);
    return {
      captions,
      transcript: {
        ...transcript,
        provenance: {
          ...transcript.provenance,
          networkSandbox: process.platform === "darwin",
        },
        sourceSha256: source.asset.sha256,
        silenceCandidates: silenceCandidates(captions, source.asset.durationMs),
        timing:
          "source milliseconds; word alignment when valid, otherwise character-weighted interpolation; review all timing",
        reviewRequired: true,
      },
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
