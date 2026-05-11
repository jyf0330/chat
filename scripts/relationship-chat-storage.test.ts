import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { RelationshipChatStore } from "./relationship-chat-storage.ts";

function withStore(fn: (store: RelationshipChatStore) => void) {
  const dir = mkdtempSync(join(tmpdir(), "relationship-chat-store-"));
  try {
    const store = new RelationshipChatStore(join(dir, "chat.sqlite"));
    fn(store);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("creates anonymous sessions and records a full simulation turn", () => {
  withStore((store) => {
    const session = store.createSession({
      visitorId: "visitor-a",
      consentForDataset: true,
      userAgent: "node-test",
    });

    store.recordSimulation({
      sessionId: session.id,
      caseId: "case-1",
      mode: "chat",
      consentForDataset: true,
      userReply: "我应该怎么回她?",
      turns: [{ role: "advisor", text: "先放慢节奏" }],
      result: {
        target_reply: "你先忙也没关系。",
        best_strategy: "尊重她的节奏。",
        recommended_reply: "嗯嗯，那我先把事情做完，晚点再找你。",
        judge: {
          boundary_score: 2,
          pressure_score: 1,
          trust_score: 2,
          empathy_score: 2,
          relevance_score: 0,
          risk_score: 2,
          risk_level_after: "low",
          verdict: "回复尊重边界。",
        },
        next_suggestion: "继续轻松回应。",
      },
    });

    const stats = store.getStats();
    assert.equal(stats.sessions, 1);
    assert.equal(stats.simulations, 1);
    assert.equal(stats.messages, 4);
    assert.equal(stats.datasetConsentedSessions, 1);
  });
});

test("exports only consented sessions and masks obvious contact details", () => {
  withStore((store) => {
    const allowed = store.createSession({
      visitorId: "visitor-allowed",
      consentForDataset: true,
    });
    const denied = store.createSession({
      visitorId: "visitor-denied",
      consentForDataset: false,
    });

    store.recordSimulation({
      sessionId: allowed.id,
      caseId: "case-allowed",
      mode: "chat",
      consentForDataset: true,
      userReply: "她微信是 my_wechat_123，手机号 13812345678，我该怎么回?",
      turns: [],
      result: {
        target_reply: "你先别催我。",
        best_strategy: "停止施压。",
        recommended_reply: "好的，我不催你了。",
      },
    });
    store.recordSimulation({
      sessionId: denied.id,
      caseId: "case-denied",
      mode: "chat",
      consentForDataset: false,
      userReply: "这条不同意进入数据集",
      turns: [],
      result: {
        target_reply: "不会被导出。",
      },
    });

    const lines = store.exportDatasetJsonl().trim().split("\n");
    assert.equal(lines.length, 1);

    const exported = JSON.parse(lines[0]);
    assert.equal(exported.session_id, allowed.id);
    assert.equal(exported.case_id, "case-allowed");
    assert.match(JSON.stringify(exported), /\[PHONE\]/);
    assert.match(JSON.stringify(exported), /\[WECHAT\]/);
    assert.doesNotMatch(JSON.stringify(exported), /13812345678/);
    assert.doesNotMatch(JSON.stringify(exported), /这条不同意进入数据集/);
  });
});

test("history summarizes game titles and best or worst turns", () => {
  withStore((store) => {
    const session = store.createSession({
      visitorId: "visitor-history",
      consentForDataset: true,
    });

    store.recordSimulation({
      sessionId: session.id,
      caseId: "custom-rem",
      mode: "chat",
      consentForDataset: true,
      customCase: {
        id: "custom-rem",
        real_relationship_scene: "蕾姆:主人今天在忙什么?",
        relationship_stage_label: "热聊升温",
        target_emotion_label: "撒娇",
        risk_level: "low",
        wrong_reply: "别烦我",
        best_strategy: "温柔回应",
        recommended_reply: "嗯嗯，我在忙一点点。",
        user_feedback: null,
      },
      userReply: "我今天在写代码。",
      turns: [],
      result: {
        target_reply: "主人辛苦啦。",
        best_strategy: "继续温柔回应。",
        recommended_reply_80: "嗯嗯，有你陪我就不累。",
        recommended_reply: "嗯嗯，有你陪我就不累。",
        perfect_reply_100: "嗯嗯，蕾姆陪着我，我会更有动力把事情做好。",
        judge: {
          boundary_score: 2,
          pressure_score: 1,
          trust_score: 2,
          empathy_score: 2,
          relevance_score: 0,
          risk_score: 2,
          risk_level_after: "low",
          verdict: "安全升温。",
        },
        game: {
          schema_version: "relationship_game_score_v1",
          max_turns: 10,
          turn_count: 1,
          score: 15,
          title: "稳定对话",
          highest_score: 15,
          highest_title: "稳定对话",
          is_complete: false,
          completion_reason: null,
          rounds: [
            {
              turn: 1,
              score_before: 0,
              raw_score: 9,
              display_score: 3,
              score_delta: 15,
              score_after: 15,
              title_after: "稳定对话",
              judge: {
                risk_level_after: "low",
                boundary_score: 2,
                pressure_score: 1,
                trust_score: 2,
                empathy_score: 2,
                relevance_score: 0,
                risk_score: 2,
                evidence: [],
                verdict: "安全升温。",
              },
              verdict: "安全升温。",
            },
          ],
        },
      },
    });

    const history = store.getHistory("visitor-history");
    assert.equal(history.length, 1);
    assert.equal(history[0].final_score, 15);
    assert.equal(history[0].final_title, "稳定对话");
    assert.equal(history[0].highest_title, "稳定对话");
    assert.equal(history[0].best_turn?.score_delta, 15);
    assert.equal(history[0].best_turn?.perfect_reply_100, "嗯嗯，蕾姆陪着我，我会更有动力把事情做好。");
  });
});
