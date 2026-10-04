import { DISPLAY_NAMES } from "../../../../launcher/src/display-names.js";
import { spawn } from "node:child_process";

export function runNative(
  binary,
  args,
  { timeoutMs = 180000, onProgress, completeStderr = false, maxStderrBytes = 65536 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "",
      settled = false, overflow=false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-2_000_000);
    });
    child.stderr.on("data", (chunk) => {
      if(completeStderr){if(Buffer.byteLength(stderr)+chunk.length>maxStderrBytes){overflow=true;child.kill("SIGKILL");return;}stderr+=chunk;}else stderr = (stderr + chunk).slice(-16000);
      onProgress?.(String(chunk));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      settled = true;
      reject(
        new Error(`Cannot start native media tool ${binary}: ${error.message}`),
      );
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      if(overflow)return reject(new Error("Native diagnostics exceeded the complete-output limit; no evidence admitted."));
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `Native media command failed (${signal || code}): ${stderr.slice(-5000)}`,
          ),
        );
    });
  });
}

export async function qualifyFFmpeg(explicitBinary) {
  const binary = explicitBinary || process.env.FFMPEG_PATH || "ffmpeg";
  const { stdout, stderr } = await runNative(
    binary,
    ["-hide_banner", "-version"],
    { timeoutMs: 10000 },
  );
  const version = stdout + stderr;
  if (!/ffmpeg version/.test(version) || !/configuration:/.test(version))
    throw new Error(
      "FFmpeg qualification failed: native build configuration is unavailable.",
    );
  if (/--enable-nonfree(?:\s|$)/.test(version))
    throw new Error(
      `${DISPLAY_NAMES.studio} rejects FFmpeg builds with --enable-nonfree. Use the qualified local competition executable.`,
    );
  const licenseProfile = /--enable-gpl(?:\s|$)/.test(version)
    ? "GPL_LOCAL_COMPETITION_ONLY"
    : "LGPL_LOCAL_EXECUTABLE";
  const encoders = await runNative(binary, ["-hide_banner", "-encoders"], {
    timeoutMs: 10000,
  });
  const listing = encoders.stdout + encoders.stderr;
  const encoder = /\bh264_videotoolbox\b/.test(listing)
    ? "h264_videotoolbox"
    : /\blibopenh264\b/.test(listing)
      ? "libopenh264"
      : /\blibx264\b/.test(listing)
        ? "libx264"
        : null;
  if (!encoder)
    throw new Error(
      `${DISPLAY_NAMES.studio} needs a local H.264 encoder: h264_videotoolbox, libopenh264, or libx264. This FFmpeg build has none.`,
    );
  return {
    binary,
    encoder,
    licenseProfile,
    distribution:
      "LOCAL_EXECUTION_ONLY; binary bundling and redistribution are not approved",
    version: version.split("\n").slice(0, 3).join("\n"),
  };
}
