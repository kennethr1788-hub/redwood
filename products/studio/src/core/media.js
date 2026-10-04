import { DISPLAY_NAMES } from "../../../../launcher/src/display-names.js";
import { spawn } from "node:child_process";
export const binary = (name) =>
  process.env[name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"] || name;
export function run(
  program,
  args,
  { timeout = 30000, maxBytes = 1024 * 1024 } = {},
) {
  return new Promise((resolve, reject) => {
    const p = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "",
      err = "",
      done = false;
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      finish(Error(`${program} timed out`));
    }, timeout);
    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(out);
    }
    p.on("error", (e) =>
      finish(
        Error(
          `Cannot run ${program}: ${e.message}. See ${DISPLAY_NAMES.studio} setup instructions.`,
        ),
      ),
    );
    p.stdout.on("data", (d) => {
      out += d;
      if (out.length > maxBytes) {
        p.kill("SIGKILL");
        finish(Error("Tool output limit exceeded"));
      }
    });
    p.stderr.on("data", (d) => {
      err = (err + d).slice(-12000);
    });
    p.on("close", (code) =>
      finish(
        code === 0
          ? null
          : Error(`${program} failed (${code}): ${err.slice(-1600)}`),
      ),
    );
  });
}
export async function probe(path) {
  let p;
  try {
    p = JSON.parse(
      await run(binary("ffprobe"), [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        path,
      ]),
    );
  } catch (e) {
    throw Error(
      "Invalid or unreadable media. Choose a playable MP4, MOV, WebM or MKV video. If media tools are missing, run the README setup command.",
      { cause: e },
    );
  }
  const v = p.streams?.find((s) => s.codec_type === "video");
  const durationMs = Math.round(
    Number(p.format?.duration || v?.duration) * 1000,
  );
  if (
    !v ||
    !Number.isFinite(durationMs) ||
    durationMs < 500 ||
    durationMs > 120000 ||
    v.width < 16 ||
    v.height < 16 ||
    v.width > 7680 ||
    v.height > 4320
  )
    throw Error(
      "Unsupported media: require a video 0.5–120 seconds, at most 7680 × 4320.",
    );
  return {
    width: v.width,
    height: v.height,
    durationMs,
    hasAudio: p.streams.some((s) => s.codec_type === "audio"),
  };
}
