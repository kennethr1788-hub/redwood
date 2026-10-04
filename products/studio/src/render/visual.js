import {outputCaptions} from '../timeline/project.js';
import path from "node:path";
import { chromium } from "playwright";

export function layoutFor(width, height, asset) {
  const vertical = height > width;
  const maxWidth = width - 144, maxHeight = height - 256;
  const ratio = asset.width / asset.height;
  // Extreme panoramic/tall imports retain context without exceeding the
  // compositor's zoom ceiling. Ordinary recordings use the full focus window.
  const videoWidth = vertical
    ? Math.max(2, Math.floor(Math.min(width - 88, 700 * ratio * 4) / 2) * 2)
    : Math.max(2, Math.floor(Math.min(maxWidth, maxHeight * ratio) / 2) * 2);
  const videoHeight = vertical
    ? Math.max(2, Math.floor(Math.min(700, videoWidth / ratio * 4) / 2) * 2)
    : Math.max(2, Math.floor(videoWidth / ratio / 2) * 2);
  return {
    width, height, vertical, videoWidth, videoHeight,
    x: Math.floor((width - videoWidth) / 2),
    y: vertical ? 342 + Math.floor((700 - videoHeight) / 2) : 156,
    captionTop: vertical ? 1080 : 628,
  };
}

export async function createVisualAssets(workDir, timeline, studio) {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 1280 },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      '<html><body style="margin:0;background:transparent"><canvas id="canvas"></canvas></body></html>',
    );
    for (const [name, width, height] of [
      ["landscape", 1280, 720],
      ["vertical", 720, 1280],
    ]) {
      const layout = layoutFor(width, height, studio.asset);
      const shell = path.join(workDir, `${name}-shell.png`);
      await page.evaluate(
        ({ layout, timeline }) => {
          const {
            width: w,
            height: h,
            vertical,
            videoWidth: vw,
            videoHeight: vh,
            x,
            y,
          } = layout;
          const canvas = document.getElementById("canvas");
          canvas.width = w;
          canvas.height = h;
          const c = canvas.getContext("2d");
          const colors = {
            aurora: ["#100f20", "#302451", "#7562a2"],
            midnight: ["#090f1c", "#15273b", "#315065"],
            ember: ["#291a23", "#674150", "#b57a72"],
          }[timeline.theme];
          const bg = c.createLinearGradient(0, h, w, 0);
          bg.addColorStop(0, colors[0]);
          bg.addColorStop(0.62, colors[1]);
          bg.addColorStop(1, colors[2]);
          c.fillStyle = bg;
          c.fillRect(0, 0, w, h);
          const glow = c.createRadialGradient(
            w * 0.8,
            h * 0.08,
            0,
            w * 0.8,
            h * 0.08,
            w * 0.8,
          );
          glow.addColorStop(0, "#ffffff20");
          glow.addColorStop(1, "#ffffff00");
          c.fillStyle = glow;
          c.fillRect(0, 0, w, h);
          c.strokeStyle = "#ffffff04";
          c.lineWidth = 1;
          for (let i = 0; i < w; i += 64) {
            c.beginPath();
            c.moveTo(i, 0);
            c.lineTo(i, h);
            c.stroke();
          }
          c.fillStyle = "#d5c7f6";
          c.textAlign = "center";
          c.font = `600 ${vertical ? 13 : 10}px -apple-system,BlinkMacSystemFont,sans-serif`;
          c.letterSpacing = "3px";
          c.fillText("LAUNCHFORGE  /  STUDIO", w / 2, vertical ? 75 : 30);
          c.letterSpacing = "0px";
          function wrap(text, maxWidth, font, maxLines) {
            c.font = font;
            const words = String(text).split(/\s+/);
            const lines = [];
            let line = "";
            for (const word of words) {
              const trial = line ? line + " " + word : word;
              if (c.measureText(trial).width > maxWidth && line) {
                lines.push(line);
                line = word;
              } else line = trial;
            }
            if (line) lines.push(line);
            if (lines.length > maxLines) {
              lines.length = maxLines;
              lines[maxLines - 1] =
                lines[maxLines - 1].replace(/\s+\S*$/, "") + "…";
            }
            return lines;
          }
          const titleLines = wrap(
            timeline.title,
            w - (vertical ? 110 : 120),
            `650 ${vertical ? 48 : 36}px -apple-system,BlinkMacSystemFont,sans-serif`,
            vertical ? 2 : 1,
          );
          c.fillStyle = "#faf7ff";
          titleLines.forEach((line, i) =>
            c.fillText(line, w / 2, (vertical ? 147 : 81) + i * 56, w - 110),
          );
          c.fillStyle = "#e1d8edd4";
          const subtitleY = vertical ? 181 + (titleLines.length - 1) * 56 : 116;
          wrap(
            timeline.subtitle,
            w - 120,
            `${vertical ? 20 : 15}px -apple-system,BlinkMacSystemFont,sans-serif`,
            vertical ? 2 : 1,
          ).forEach((line, i) => c.fillText(line, w / 2, subtitleY + i * 29, w - 120));
          const chrome = 30,
            edge = 8;
          c.shadowColor = "#080512a8";
          c.shadowBlur = 65;
          c.shadowOffsetY = 26;
          c.fillStyle = "#12101b";
          c.beginPath();
          c.roundRect(
            x - edge,
            y - chrome,
            vw + edge * 2,
            vh + chrome + edge,
            15,
          );
          c.fill();
          c.shadowColor = "transparent";
          c.strokeStyle = "#ffffff30";
          c.lineWidth = 1;
          c.stroke();
          for (let i = 0; i < 3; i++) {
            c.fillStyle = ["#fe827c", "#e8c26c", "#79c9a6"][i];
            c.beginPath();
            c.arc(x + 11 + i * 15, y - 15, 3.6, 0, Math.PI * 2);
            c.fill();
          }
          c.fillStyle = "#a8a0b4";
          c.font = "10px -apple-system,BlinkMacSystemFont,sans-serif";
          c.fillText("THE PRODUCT, IN MOTION", w / 2, y - 12);
          c.globalCompositeOperation = "destination-out";
          c.beginPath();
          c.roundRect(x, y, vw, vh, 10);
          c.fill();
          c.globalCompositeOperation = "source-over";
          c.fillStyle = "#dacceb90";
          c.font = `500 ${vertical ? 11 : 9}px -apple-system,BlinkMacSystemFont,sans-serif`;
          c.letterSpacing = "2px";
          c.fillText("IDEA  →  EXPERIENCE", w / 2, h - (vertical ? 65 : 24));
          c.letterSpacing = "0px";
        },
        { layout, timeline },
      );
      await page
        .locator("#canvas")
        .screenshot({ path: shell, omitBackground: true });
      const captions = [];
      for (const [i, caption] of outputCaptions(timeline).entries()) {
        const file = path.join(workDir, `${name}-caption-${i}.png`);
        await page.evaluate(
          ({ width: w, height: h, vertical, text, captionTop }) => {
            const canvas = document.getElementById("canvas");
            canvas.width = w;
            canvas.height = h;
            const c = canvas.getContext("2d");
            c.font = `600 ${vertical ? 24 : 18}px -apple-system,BlinkMacSystemFont,sans-serif`;
            const maxWidth = w - (vertical ? 100 : 180);
            const lines = [];
            let line = "";
            for (const word of text.split(/\s+/)) {
              const next = line ? `${line} ${word}` : word;
              if (c.measureText(next).width > maxWidth - 48 && line) {
                lines.push(line);
                line = word;
              } else line = next;
            }
            if (line) lines.push(line);
            const maxLines = vertical ? 3 : 2;
            if (lines.length > maxLines) {
              lines.length = maxLines;
              lines[maxLines - 1] += "…";
            }
            const boxWidth = Math.min(
                maxWidth,
                Math.max(...lines.map((l) => c.measureText(l).width)) + 48,
              ),
              boxHeight = lines.length * (vertical ? 26 : 22) + 12,
              top = captionTop;
            c.shadowColor = "#05020f66";
            c.shadowBlur = 24;
            c.fillStyle = "#100d20ed";
            c.beginPath();
            c.roundRect((w - boxWidth) / 2, top, boxWidth, boxHeight, 14);
            c.fill();
            c.shadowColor = "transparent";
            c.strokeStyle = "#ffffff25";
            c.stroke();
            c.textAlign = "center";
            c.fillStyle = "#ffffff";
            lines.forEach((l, i) => c.fillText(l, w / 2, top + (vertical ? 27 : 23) + i * (vertical ? 26 : 22), maxWidth - 48));
          },
          { width, height, vertical: layout.vertical, text: caption.text, captionTop: layout.captionTop },
        );
        await page
          .locator("#canvas")
          .screenshot({ path: file, omitBackground: true });
        captions.push({
          file,
          start: caption.startMs / 1000,
          end: caption.endMs / 1000,
        });
      }
      const closing = path.join(workDir, `${name}-closing.png`);
      await page.evaluate(({ width: w, height: h, vertical }) => {
        const canvas = document.getElementById("canvas");
        canvas.width = w; canvas.height = h;
        const c = canvas.getContext("2d");
        // A quiet final signature in the footer; never covers captions or content.
        c.fillStyle = "#171222";
        c.fillRect(0, h - (vertical ? 49 : 24), w, vertical ? 49 : 24);
        c.textAlign = "center";
        c.fillStyle = "#eee6ff";
        c.font = `600 ${vertical ? 15 : 10}px -apple-system,BlinkMacSystemFont,sans-serif`;
        c.fillText("YOUR NEXT CHAPTER STARTS HERE  →", w / 2, h - (vertical ? 22 : 8));
      }, { width, height, vertical: layout.vertical });
      await page.locator("#canvas").screenshot({ path: closing, omitBackground: true });
      results.push({ name, layout, shell, captions, closing });
    }
    const cursor = path.join(workDir, "cursor.png");
    await page.evaluate(() => {
      const canvas = document.getElementById("canvas");
      canvas.width = 36;
      canvas.height = 42;
      const c = canvas.getContext("2d");
      c.shadowColor = "#00000080";
      c.shadowBlur = 4;
      c.shadowOffsetY = 2;
      c.beginPath();
      c.moveTo(5, 4);
      c.lineTo(5, 30);
      c.lineTo(12, 24);
      c.lineTo(18, 36);
      c.lineTo(24, 33);
      c.lineTo(18, 22);
      c.lineTo(29, 22);
      c.closePath();
      c.fillStyle = "#fbf9ff";
      c.fill();
      c.shadowColor = "transparent";
      c.strokeStyle = "#241a3e";
      c.lineWidth = 1.5;
      c.stroke();
    });
    await page
      .locator("#canvas")
      .screenshot({ path: cursor, omitBackground: true });
    const ring = path.join(workDir, "click-pulse.png");
    await page.evaluate(() => {
      const canvas = document.getElementById("canvas");
      canvas.width = 72 * 8;
      canvas.height = 72;
      const c = canvas.getContext("2d");
      for (let i = 0; i < 8; i++) {
        c.strokeStyle = `rgba(210,186,255,${1 - i / 8})`;
        c.lineWidth = 3;
        c.beginPath();
        c.arc(i * 72 + 36, 36, 9 + i * 3.1, 0, Math.PI * 2);
        c.stroke();
      }
    });
    await page
      .locator("#canvas")
      .screenshot({ path: ring, omitBackground: true });
    return { variants: results, cursor, ring };
  } finally {
    await browser.close();
  }
}
