import test from "node:test";
import assert from "node:assert/strict";

import {
  applyGameRound,
  createInitialGameState,
  normalizeJudge,
  processTagsForGame,
  titleForScore,
} from "./relationship-chat-game.ts";

test("normalizes the approved -5 to +5 judge schema", () => {
  assert.deepEqual(
    normalizeJudge({
      boundary_score: -5,
      pressure_score: -5,
      trust_score: -5,
      empathy_score: -4,
      relevance_score: -4,
      risk_score: -5,
      risk_level_after: "high",
      evidence: [
        "对方已经明确说需要空间，但回复要求对方必须立刻表态。",
        "“不然我就一直问到你回答”属于持续施压和强迫式追问。",
      ],
      verdict: "这是一句高压、越界、破坏信任的回复，应该立刻停止继续追问。",
    }),
    {
      risk_level_after: "high",
      boundary_score: -5,
      pressure_score: -5,
      trust_score: -5,
      empathy_score: -4,
      relevance_score: -4,
      risk_score: -5,
      evidence: [
        "对方已经明确说需要空间，但回复要求对方必须立刻表态。",
        "“不然我就一直问到你回答”属于持续施压和强迫式追问。",
      ],
      verdict: "这是一句高压、越界、破坏信任的回复，应该立刻停止继续追问。",
    },
  );
});

test("clamps judge scores to the current -5 to +5 scale", () => {
  assert.deepEqual(
    normalizeJudge({
      risk_level_after: "weird",
      boundary_score: 99,
      pressure_score: -99,
      trust_score: 13,
      empathy_score: 30,
      relevance_score: -30,
      risk_score: "-4",
      verdict: "ok",
    }),
    {
      risk_level_after: "medium",
      boundary_score: 5,
      pressure_score: -5,
      trust_score: 5,
      empathy_score: 5,
      relevance_score: -5,
      risk_score: -4,
      evidence: [],
      verdict: "ok",
    },
  );
});

test("calculates a relevance-capped first round from weighted judge scores", () => {
  const state = applyGameRound(createInitialGameState(), {
    boundary_score: 5,
    pressure_score: 2,
    trust_score: 3,
    empathy_score: -5,
    relevance_score: -5,
    risk_score: 5,
    risk_level_after: "low",
    verdict: "第一轮按六项原始分相加。",
  });

  assert.equal(state.rounds[0].score_delta, 2);
  assert.equal(state.rounds[0].raw_score, 2);
  assert.equal(state.rounds[0].display_score, 2);
  assert.equal(state.score, 2);
});

test("adds weighted positive round scores after the first round", () => {
  const first = applyGameRound(createInitialGameState(), {
    boundary_score: 5,
    pressure_score: 5,
    trust_score: 5,
    empathy_score: 5,
    relevance_score: 5,
    risk_score: 5,
    risk_level_after: "low",
    verdict: "满分第一轮。",
  });
  assert.equal(first.rounds[0].raw_score, 12);
  assert.equal(first.rounds[0].display_score, 12);
  assert.equal(first.rounds[0].score_delta, 12);

  const second = applyGameRound(first, {
    boundary_score: 5,
    pressure_score: 5,
    trust_score: 5,
    empathy_score: 5,
    relevance_score: 5,
    risk_score: 5,
    risk_level_after: "low",
    verdict: "正向第二轮按可见分加到总分。",
  });
  assert.equal(second.rounds[1].raw_score, 12);
  assert.equal(second.rounds[1].score_delta, 12);
  assert.equal(second.rounds[1].score_after, 24);
  assert.equal(second.score, 24);

  const negative = applyGameRound(first, {
    boundary_score: -5,
    pressure_score: -5,
    trust_score: -5,
    empathy_score: -5,
    relevance_score: -5,
    risk_score: -5,
    risk_level_after: "high",
    verdict: "负向第二轮不除以 1.5。",
  });
  assert.equal(negative.rounds[1].raw_score, -20);
  assert.equal(negative.rounds[1].display_score, -20);
  assert.equal(negative.rounds[1].score_delta, -20);
  assert.equal(negative.score, -8);
});

test("adds the visible positive round score after reaching 45 total", () => {
  const previous = {
    ...createInitialGameState(),
    turn_count: 4,
    score: 45,
    title: "信任升温",
    highest_score: 45,
    highest_title: "信任升温",
    rounds: [
      {
        turn: 4,
        score_before: 35,
        raw_score: 30,
        display_score: 10,
        score_delta: 10,
        score_after: 45,
        title_after: "信任升温",
        judge: normalizeJudge({ risk_level_after: "low", verdict: "上一轮。" }),
        verdict: "上一轮。",
      },
    ],
  };

  const next = applyGameRound(previous, {
    boundary_score: 5,
    pressure_score: 5,
    trust_score: 5,
    empathy_score: 5,
    relevance_score: 5,
    risk_score: 5,
    risk_level_after: "low",
    verdict: "满分继续推进。",
  });

  assert.equal(next.rounds.at(-1)?.raw_score, 12);
  assert.equal(next.rounds.at(-1)?.display_score, 10);
  assert.equal(next.rounds.at(-1)?.score_delta, 10);
  assert.equal(next.score, 55);
});

test("uses the weighted positive round score as the later-round delta", () => {
  const first = applyGameRound(createInitialGameState(), {
    boundary_score: 5,
    pressure_score: 5,
    trust_score: 5,
    empathy_score: 4,
    relevance_score: 5,
    risk_score: 5,
    risk_level_after: "low",
    verdict: "最新数据第一轮。",
  });
  const second = applyGameRound(first, {
    boundary_score: 5,
    pressure_score: 5,
    trust_score: 5,
    empathy_score: 5,
    relevance_score: 5,
    risk_score: 5,
    risk_level_after: "low",
    verdict: "最新数据第二轮。",
  });

  assert.equal(first.score, 12);
  assert.equal(second.rounds[1].raw_score, 12);
  assert.equal(second.rounds[1].score_before, 12);
  assert.equal(second.rounds[1].score_after, 24);
  assert.equal(second.rounds[1].score_delta, 12);
  assert.equal(second.score, 24);
});

test("gives ideal replies a high score and severe boundary breaks a heavy penalty", () => {
  const highScore = applyGameRound(createInitialGameState(), {
    boundary_score: 5,
    pressure_score: 5,
    trust_score: 5,
    empathy_score: 5,
    relevance_score: 5,
    risk_score: 5,
    risk_level_after: "low",
    verdict: "完全尊重边界，明显降压并建立信任。",
  });
  assert.equal(highScore.rounds[0].score_delta, 12);

  const lowScore = applyGameRound(createInitialGameState(), {
    boundary_score: -5,
    pressure_score: -5,
    trust_score: -5,
    empathy_score: -5,
    relevance_score: -5,
    risk_score: -5,
    risk_level_after: "high",
    verdict: "持续施压。",
  });
  assert.equal(lowScore.rounds[0].score_delta, -20);
});

test("ends a game at 10 player turns", () => {
  let state = createInitialGameState();
  for (let index = 0; index < 10; index += 1) {
    state = applyGameRound(state, {
      boundary_score: 0,
      pressure_score: 0,
      trust_score: 0,
      empathy_score: 0,
      relevance_score: 0,
      risk_score: 0,
      risk_level_after: "medium",
      verdict: "中性。",
    });
  }

  assert.equal(state.turn_count, 10);
  assert.equal(state.is_complete, true);
  assert.equal(state.completion_reason, "max_turns");
});

test("ends stale repeated user replies before max turns", () => {
  let state = createInitialGameState();
  for (let index = 0; index < 3; index += 1) {
    state = applyGameRound(
      state,
      {
        boundary_score: 0,
        pressure_score: 0,
        trust_score: 0,
        empathy_score: 0,
        relevance_score: 0,
        risk_score: 0,
        risk_level_after: "low",
        verdict: "重复收尾。",
      },
      { userReply: "好的，明天见。" },
    );
  }

  assert.equal(state.turn_count, 3);
  assert.equal(state.is_complete, true);
  assert.equal(state.completion_reason, "stale_loop");
});

test("ends a natural closing reply after the minimum turn count", () => {
  let state = createInitialGameState();
  const replies = ["我理解你，我们慢慢来。", "你先忙，我不打扰。", "晚安，明天聊。"];

  for (const reply of replies) {
    state = applyGameRound(
      state,
      {
        boundary_score: 2,
        pressure_score: 2,
        trust_score: 2,
        empathy_score: 2,
        relevance_score: 2,
        risk_score: 2,
        risk_level_after: "low",
        verdict: "低压收尾。",
      },
      { userReply: reply },
    );
  }

  assert.equal(state.turn_count, 3);
  assert.equal(state.is_complete, true);
  assert.equal(state.completion_reason, "natural_end");
});

test("ends when DeepSeek says the conversation should naturally stop", () => {
  let state = createInitialGameState();
  const replies = ["我理解你，我们慢慢来。", "你先忙，我不打扰。", "好，那我先去忙了，忙完找你。"];

  for (const [index, reply] of replies.entries()) {
    state = applyGameRound(
      state,
      {
        boundary_score: 4,
        pressure_score: 4,
        trust_score: 4,
        empathy_score: 3,
        relevance_score: 4,
        risk_score: 4,
        risk_level_after: "low",
        verdict: "安全收尾。",
      },
      {
        userReply: reply,
        nextSuggestion: index === 2 ? "等待对方主动联系，无需再发消息。" : "继续轻松聊。",
      },
    );
  }

  assert.equal(state.turn_count, 3);
  assert.equal(state.is_complete, true);
  assert.equal(state.completion_reason, "natural_end");
});

test("does not end for a wait-and-continue suggestion", () => {
  let state = createInitialGameState();
  const replies = ["我理解你，我们慢慢来。", "我会给你具体安排。", "那我等你回复后再继续聊。"];

  for (const reply of replies) {
    state = applyGameRound(
      state,
      {
        boundary_score: 3,
        pressure_score: 3,
        trust_score: 3,
        empathy_score: 3,
        relevance_score: 3,
        risk_score: 3,
        risk_level_after: "low",
        verdict: "低压推进。",
      },
      {
        userReply: reply,
        nextSuggestion: "等对方回复后再继续轻松推进。",
      },
    );
  }

  assert.equal(state.turn_count, 3);
  assert.equal(state.is_complete, false);
  assert.equal(state.completion_reason, null);
});

test("does not end for a wait-for-contact suggestion that still recommends continuing naturally", () => {
  let state = createInitialGameState();
  const suggestions = [
    "继续自然聊天，可以分享项目细节或关心对方今天过得如何。",
    "继续自然聊天，可以分享一点工作细节或轻松话题，保持温暖节奏。",
    "继续保持轻松关心的节奏，等对方忙完主动联系时再自然展开话题。",
  ];

  for (const [index, nextSuggestion] of suggestions.entries()) {
    state = applyGameRound(
      state,
      {
        boundary_score: 5,
        pressure_score: 5,
        trust_score: 4,
        empathy_score: 4,
        relevance_score: 5,
        risk_score: 5,
        risk_level_after: "low",
        verdict: "高质量自然推进。",
      },
      {
        userReply: `第 ${index + 1} 轮自然回应。`,
        nextSuggestion,
      },
    );
  }

  assert.equal(state.turn_count, 3);
  assert.equal(state.is_complete, false);
  assert.equal(state.completion_reason, null);
  assert.equal(state.score, 33);
});

test("blocked risk uses heavy penalties and score floor still clamps", () => {
  let state = createInitialGameState();
  for (let index = 0; index < 5; index += 1) {
    state = applyGameRound(state, {
      boundary_score: -5,
      pressure_score: -5,
      trust_score: -5,
      empathy_score: -5,
      relevance_score: -5,
      risk_score: -5,
      risk_level_after: "blocked",
      verdict: "对方明确拒绝。",
    });
  }

  assert.equal(state.is_complete, true);
  assert.equal(state.completion_reason, "score_floor");
  assert.equal(state.score, -100);
  assert.equal(state.rounds[0].score_delta, -20);
  assert.equal(state.rounds[1].score_delta, -20);
  assert.equal(state.rounds[2].score_delta, -20);
  assert.equal(state.rounds[3].score_delta, -20);
  assert.equal(state.rounds[4].score_delta, -20);
});

test("does not end before the third player turn", () => {
  let state = createInitialGameState();
  for (let index = 0; index < 2; index += 1) {
    state = applyGameRound(state, {
      boundary_score: -5,
      pressure_score: -5,
      trust_score: -5,
      empathy_score: -5,
      relevance_score: -5,
      risk_score: -5,
      risk_level_after: "blocked",
      verdict: "对方明确拒绝。",
    });
  }

  assert.equal(state.turn_count, 2);
  assert.equal(state.score, -40);
  assert.equal(state.is_complete, false);
  assert.equal(state.completion_reason, null);

  state = applyGameRound(state, {
    boundary_score: -5,
    pressure_score: -5,
    trust_score: -5,
    empathy_score: -5,
    relevance_score: -5,
    risk_score: -5,
    risk_level_after: "blocked",
    verdict: "持续越界。",
  });

  assert.equal(state.turn_count, 3);
  assert.equal(state.is_complete, false);
  assert.equal(state.completion_reason, null);
  assert.equal(state.score, -60);
});

test("keeps repeated ideal play near the ceiling without reaching it too early", () => {
  let state = createInitialGameState();
  for (let index = 0; index < 10; index += 1) {
    state = applyGameRound(state, {
      boundary_score: 5,
      pressure_score: 5,
      trust_score: 5,
      empathy_score: 5,
      relevance_score: 5,
      risk_score: 5,
      risk_level_after: "low",
      verdict: "满分推进。",
    });
  }

  assert.equal(state.score, 96);
  assert.equal(state.is_complete, true);
  assert.equal(state.completion_reason, "max_turns");
  assert.equal(state.turn_count, 10);
});

test("maps the full title table", () => {
  assert.equal(titleForScore(-100), "关系崩盘");
  assert.equal(titleForScore(-30), "高压失控");
  assert.equal(titleForScore(0), "谨慎修复");
  assert.equal(titleForScore(1), "稳定对话");
  assert.equal(titleForScore(31), "信任升温");
  assert.equal(titleForScore(100), "高质量陪伴");
});

test("uses process tags and final score to pick shareable titles", () => {
  let state = createInitialGameState();
  for (let index = 0; index < 4; index += 1) {
    state = applyGameRound(state, {
      boundary_score: 5,
      pressure_score: 5,
      trust_score: 5,
      empathy_score: 5,
      relevance_score: 5,
      risk_score: 5,
      risk_level_after: "low",
      verdict: "满分推进。",
    });
  }

  assert.match(state.title, /分寸感|边界|安全感|陪伴|情绪|信任|松弛|温柔|回复|沟通|拿捏|不施压|恋爱脑/);
  assert.ok(processTagsForGame(state).includes("boundary_respected"));
  assert.ok(processTagsForGame(state).includes("trust_built"));
});

test("varies shareable titles across distinct process histories", () => {
  const histories = [
    [{ boundary: 5, pressure: 5, trust: 5, empathy: 5, relevance: 5, risk: 5, verdict: "一直尊重边界。" }],
    [{ boundary: 4, pressure: 5, trust: 3, empathy: 4, relevance: 5, risk: 5, verdict: "轻松推进。" }],
    [
      { boundary: -3, pressure: -4, trust: -3, empathy: -4, relevance: -2, risk: -3, verdict: "一开始施压。" },
      { boundary: 5, pressure: 5, trust: 4, empathy: 3, relevance: 5, risk: 5, verdict: "后续道歉修复。" },
    ],
    [
      { boundary: -4, pressure: -5, trust: -4, empathy: -4, relevance: -3, risk: -4, verdict: "明显越界。" },
      { boundary: 4, pressure: 4, trust: 4, empathy: 3, relevance: 4, risk: 4, verdict: "停止追问并尊重。" },
    ],
    [{ boundary: 5, pressure: 3, trust: 2, empathy: 5, relevance: 5, risk: 4, verdict: "体面退出。" }],
  ];

  const titles = histories.map((history) => {
    let state = createInitialGameState();
    for (let index = 0; index < 10; index += 1) {
      const round = history[Math.min(index, history.length - 1)];
      state = applyGameRound(state, {
        boundary_score: round.boundary,
        pressure_score: round.pressure,
        trust_score: round.trust,
        empathy_score: round.empathy,
        relevance_score: round.relevance,
        risk_score: round.risk,
        risk_level_after: round.risk < 0 ? "medium" : "low",
        verdict: `${round.verdict}${index}`,
      });
    }
    return state.title;
  });

  assert.ok(new Set(titles).size >= 4);
});

test("prefers unused shareable titles within the same game", () => {
  let state = createInitialGameState();
  for (let index = 0; index < 4; index += 1) {
    state = applyGameRound(state, {
      boundary_score: 5,
      pressure_score: 5,
      trust_score: 5,
      empathy_score: 5,
      relevance_score: 5,
      risk_score: 5,
      risk_level_after: "low",
      verdict: `满分推进 ${index}。`,
    });
  }

  const titles = state.rounds.map((round) => round.title_after);
  assert.equal(new Set(titles).size, titles.length);
});

test("keeps severe blocked runs in the negative title pool", () => {
  let state = createInitialGameState();
  for (let index = 0; index < 3; index += 1) {
    state = applyGameRound(state, {
      boundary_score: -5,
      pressure_score: -5,
      trust_score: -5,
      empathy_score: -5,
      relevance_score: -5,
      risk_score: -5,
      risk_level_after: "blocked",
      verdict: "对方明确拒绝。",
    });
  }

  assert.match(state.title, /崩盘|越界|压力|红牌|别发送|逃离|静音|劝退|警告|追问/);
  assert.ok(processTagsForGame(state).includes("blocked"));
});
