import test from "node:test";
import assert from "node:assert/strict";

import {
  chooseRandomCaseIndex,
  shuffleCases,
} from "../web/relationship-chat/case-selection.js";

type CaseItem = { id: string };

const cases: CaseItem[] = [
  { id: "case-1" },
  { id: "case-2" },
  { id: "case-3" },
  { id: "case-4" },
];

test("chooses a random case from unplayed cases first", () => {
  const index = chooseRandomCaseIndex(cases, {
    playedCaseIds: new Set(["case-1", "case-3"]),
    currentCaseId: "case-2",
    random: () => 0.99,
  });

  assert.equal(index, 3);
});

test("falls back to the full case pool only after all cases are played", () => {
  const index = chooseRandomCaseIndex(cases, {
    playedCaseIds: new Set(cases.map((item) => item.id)),
    currentCaseId: "case-4",
    random: () => 0,
  });

  assert.equal(index, 0);
});

test("shuffles settings cases without mutating the original list", () => {
  const shuffled = shuffleCases(cases, () => 0);

  assert.deepEqual(cases.map((item) => item.id), ["case-1", "case-2", "case-3", "case-4"]);
  assert.deepEqual(shuffled.map((item) => item.id), ["case-2", "case-3", "case-4", "case-1"]);
});
