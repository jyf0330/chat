import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFiftyScenarioRunPlan,
  buildHumanReply,
  summarizeCorpusRun,
  type CorpusScenarioResult,
} from "./run-deepseek-fifty-scenario-corpus.ts";
import type { RelationshipCase } from "./relationship-chat-storage.ts";

test("builds 50 unique scenarios with 10 planned replies each", () => {
  const cases = Array.from({ length: 55 }, (_, index) => fakeCase(index + 1));

  const plan = buildFiftyScenarioRunPlan(cases, { scenarioCount: 50, turnsPerScenario: 10 });

  assert.equal(plan.length, 50);
  assert.equal(new Set(plan.map((item) => item.caseId)).size, 50);
  assert.ok(plan.every((item) => item.replies.length === 10));
  assert.ok(plan.every((item) => new Set(item.replies).size === 10));
});

test("planned replies stay human-written instead of copying recommendations", () => {
  const currentCase = fakeCase(1);
  const reply = buildHumanReply({
    currentCase,
    scenarioIndex: 0,
    turnIndex: 3,
    previousTargetReply: "我其实只是想确认你有没有认真听我说。",
  });

  assert.notEqual(reply, currentCase.recommended_reply);
  assert.doesNotMatch(reply, /晚安|你先忙|不打扰|下次再聊/);
  assert.match(reply, /你|我/);
});

test("summary only passes with live DeepSeek, 50 scenarios, 10 turns, screenshots, and no quality blockers", () => {
  const scenarios = Array.from({ length: 50 }, (_, index) => scenarioResult(index + 1, 10));
  const input = {
    runId: "test-run",
    startedAt: "2026-05-12T00:00:00.000Z",
    endedAt: "2026-05-12T00:10:00.000Z",
    elapsedMs: 600_000,
    mode: "live_deepseek_official",
    deepSeekBaseUrl: "https://api.deepseek.com",
    dbFile: ".cache/test.sqlite",
    serverPort: 5174,
    scenarios,
  };
  const summary = summarizeCorpusRun(input);

  assert.equal(summary.pass, true);
  assert.equal(summary.scenario_count, 50);
  assert.equal(summary.request_count, 500);
  assert.equal(summary.screenshot_count, 50);

  const incomplete = summarizeCorpusRun({
    ...input,
    scenarios: [scenarioResult(1, 9), ...scenarios.slice(1)],
  });
  assert.equal(incomplete.pass, false);
  assert.equal(incomplete.scenarios_with_less_than_10_turns, 1);
});

function fakeCase(index: number): RelationshipCase {
  return {
    id: `seed_game_${String(index).padStart(3, "0")}`,
    real_relationship_scene: `第 ${index} 个不同场景，对方表达了具体情绪，需要用户认真接住。`,
    relationship_stage_label: index % 2 ? "暧昧初期" : "冲突修复",
    target_emotion_label: index % 3 ? "委屈" : "犹豫",
    risk_level: index % 7 ? "medium" : "high",
    wrong_reply: "你别想太多，赶紧给我一个答案。",
    best_strategy: "先共情，再给空间。",
    recommended_reply: "我听到了，我会尊重你的节奏。",
    user_feedback: null,
  };
}

function scenarioResult(index: number, turnCount: number): CorpusScenarioResult {
  return {
    player_id: `p-${index}`,
    session_id: `s-${index}`,
    case_id: `seed_game_${String(index).padStart(3, "0")}`,
    scene: `scene ${index}`,
    stage: "暧昧初期",
    emotion: "委屈",
    risk_level: "medium",
    raw_log_file: `docs/deepseek-games/p-${index}.md`,
    screenshot_path: `output/playwright/deepseek-50x10-live/p-${index}.png`,
    html_path: `output/deepseek-50x10-live/p-${index}.html`,
    completed: turnCount === 10,
    stop_reason: turnCount === 10 ? "max_turns" : "early_stop",
    final_score: 20,
    final_title: "稳定对话",
    error: null,
    turns: Array.from({ length: turnCount }, (_, turnIndex) => ({
      turn_index: turnIndex + 1,
      http_status: 200,
      elapsed_ms: 1000,
      input_source: "live_deepseek_human_simulator",
      actual_user_reply: `reply ${turnIndex + 1}`,
      expected_reply: null,
      matched_deepseek_recommendation: false,
      deepseek_input: {
        scene: `scene ${index}`,
        fixed_labels: {
          relationship_stage: "暧昧初期",
          target_emotion: "委屈",
          risk_level: "medium",
        },
        known_bad_reply: "bad",
        seed_best_strategy: "strategy",
        seed_recommended_reply: "seed",
        previous_turns: [],
        user_reply: `reply ${turnIndex + 1}`,
        mode: "chat",
      },
      deepseek_output: {
        target_reply: `target ${turnIndex + 1}`,
        best_strategy: "strategy",
        recommended_reply_80: `recommend ${turnIndex + 1}`,
        perfect_reply_100: `perfect ${turnIndex + 1}`,
        judge: {
          risk_level_after: "low",
          boundary_score: 1,
          pressure_score: 1,
          trust_score: 1,
          empathy_score: 1,
          relevance_score: 1,
          risk_score: 1,
          evidence: ["ok"],
          verdict: "ok",
        },
        next_suggestion: "继续保持节奏。",
      },
      game: {
        schema_version: "relationship_game_score_v1",
        max_turns: 10,
        turn_count: turnIndex + 1,
        score: 20,
        title: "稳定对话",
        highest_score: 20,
        highest_title: "稳定对话",
        is_complete: turnIndex + 1 === 10,
        completion_reason: turnIndex + 1 === 10 ? "max_turns" : null,
        rounds: [],
      },
      quality: {
        matched_previous_recommendation: false,
        duplicate_user_reply: false,
        duplicate_target_reply: false,
        duplicate_recommended_reply: false,
        recommended_equals_perfect: false,
        judge_score_contradiction: false,
        after_stop_suggestion: false,
      },
    })),
  };
}
