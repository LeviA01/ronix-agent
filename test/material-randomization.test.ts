import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error The browser helper is intentionally shipped as plain JavaScript.
import { shuffledMatchingRightIds, shuffledOrderAvoiding } from "../public/js/features/material-randomization.js";

test("ordering never starts in the correct sequence", () => {
  const ids = ["first", "second", "third"];
  const result = shuffledOrderAvoiding(ids, ids, () => 0.999999);

  assert.deepEqual(result, ["second", "third", "first"]);
  assert.deepEqual(ids, ["first", "second", "third"]);
});

test("matching answers never line up with their questions", () => {
  const block = {
    left: [
      { id: "left-a", text: "A" },
      { id: "left-b", text: "B" },
    ],
    right: [
      { id: "right-a", text: "Answer A" },
      { id: "right-b", text: "Answer B" },
    ],
    pairs: [
      { leftId: "left-a", rightId: "right-a" },
      { leftId: "left-b", rightId: "right-b" },
    ],
  };

  assert.deepEqual(
    shuffledMatchingRightIds(block, () => 0.999999),
    ["right-b", "right-a"],
  );
});
