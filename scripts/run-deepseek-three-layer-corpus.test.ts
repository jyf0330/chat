import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("human simulator prompt fixes the speaker to the player side", () => {
  const source = readFileSync("scripts/run-deepseek-three-layer-corpus.ts", "utf8");

  assert.match(source, /你扮演的是正在输入回复的玩家方/);
  assert.match(source, /不要扮演 scene 里正在抱怨、拒绝、撒娇或回应你的对方/);
});

test("three-layer runner still writes a browser-loadable admin JSON", () => {
  const source = readFileSync("scripts/run-deepseek-three-layer-corpus.ts", "utf8");

  assert.match(source, /web", "relationship-chat"/);
  assert.match(source, /admin_json/);
});
