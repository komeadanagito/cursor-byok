import assert from "node:assert/strict";
import test from "node:test";
import { modelNoteTooLong } from "../../apps/desktop/src/features/models/modelNote.ts";

test("model notes warn only when more than five visible characters remain after trimming", () => {
  for (const note of ["", "  五个中文字  ", "abcde", "家👨‍👩‍👧‍👦庭"]) {
    assert.equal(modelNoteTooLong(note), false, note);
  }
  for (const note of ["六个中文字啊", "abcdef", "你好👩‍💻世界呀"]) {
    assert.equal(modelNoteTooLong(note), true, note);
  }
});
