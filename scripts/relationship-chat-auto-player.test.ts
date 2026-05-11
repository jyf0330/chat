import test from "node:test";
import assert from "node:assert/strict";

import {
  chooseAutoPlayerOpeningReply,
  chooseAutoPlayerNextReply,
  shouldStopAutoPlayer,
} from "./relationship-chat-auto-player.ts";
import type { RelationshipCase, SimulationResult } from "./relationship-chat-storage.ts";

const sampleCase: RelationshipCase = {
  id: "seed_game_048",
  real_relationship_scene: "她说有空可以一起喝咖啡，但没有定时间。",
  relationship_stage_label: "普通朋友",
  target_emotion_label: "犹豫",
  risk_level: "medium",
  wrong_reply: "那你到底哪天有空？别只是随口说说。",
  best_strategy: "给一个具体选项，同时保留拒绝和改期空间。",
  recommended_reply: "周六下午或者周日傍晚你哪个更轻松？不方便也可以以后再说。",
  user_feedback: null,
};

test("starts auto high-score runs from the current case seed reply", () => {
  assert.equal(
    chooseAutoPlayerOpeningReply(sampleCase, "高分尊重边界"),
    "周六下午或者周日傍晚你哪个更轻松？不方便也可以以后再说。",
  );
});

test("starts auto repair runs from the current case wrong reply", () => {
  assert.equal(
    chooseAutoPlayerOpeningReply(sampleCase, "明显越界再道歉"),
    "那你到底哪天有空？别只是随口说说。",
  );
});

test("does not feed a repeated recommended reply back into the next auto turn", () => {
  const result: SimulationResult = {
    recommended_reply_80: "好的，明天见。",
    perfect_reply_100: "好的，明天见。",
    next_suggestion: "继续当前策略。",
  };

  assert.equal(
    chooseAutoPlayerNextReply({
      currentCase: sampleCase,
      result,
      previousUserReplies: ["好的，明天见。"],
    }),
    null,
  );
});

test("stops auto runs when recent replies are stale or naturally closed", () => {
  assert.equal(shouldStopAutoPlayer(["好的，明天见。", "好的，明天见。"]), "stale_loop");
  assert.equal(shouldStopAutoPlayer(["我理解你。", "你先忙。", "晚安，明天聊。"]), "natural_end");
});
