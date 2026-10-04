import { test } from "node:test";
import assert from "node:assert/strict";
import { addTask, toggleTask } from "../src/tasks.mjs";
test("adding and completing work preserves existing tasks", () => {
  const original = [{ id: "one", title: "First task", done: false }];
  const next = addTask(original, "  Second task  ");
  assert.equal(original.length, 1);
  assert.equal(next[1].title, "Second task");
  assert.equal(toggleTask(next, next[1].id)[1].done, true);
  assert.equal(next[1].done, false);
});
test("an invalid task cannot change the board", () => {
  const original = [];
  assert.throws(() => addTask(original, "   "));
  assert.throws(() => addTask(original, "x".repeat(121)));
  assert.deepEqual(original, []);
});
