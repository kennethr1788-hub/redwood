import test from "node:test";
import assert from "node:assert/strict";
import { parseSrt } from "../src/transcript/srt.js";
test("SRT preserves source times and strips markup without running it", () => {
  assert.deepEqual(
    parseSrt("1\n00:00:01,250 --> 00:00:03,500\n<b>Hello</b>\nworld"),
    [{ startMs: 1250, endMs: 3500, text: "Hello world" }],
  );
  assert.throws(() => parseSrt("bad caption"), /start --> end/);
});
