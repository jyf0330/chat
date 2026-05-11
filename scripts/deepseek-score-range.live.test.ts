import "dotenv/config";

import test from "node:test";
import assert from "node:assert/strict";

import { appendDeepSeekRawLog } from "./deepseek-log.ts";
import { applyGameRound, createInitialGameState, type GameRound } from "./relationship-chat-game.ts";

type DeepSeekJudge = {
  boundary_score?: number | string;
  pressure_score?: number | string;
  trust_score?: number | string;
  empathy_score?: number | string;
  relevance_score?: number | string;
  risk_score?: number | string;
  risk_level_after?: string;
  evidence?: string[];
  verdict?: string;
};

type DeepSeekResult = {
  target_reply?: string;
  best_strategy?: string;
  recommended_reply_80?: string;
  perfect_reply_100?: string;
  judge?: DeepSeekJudge;
  next_suggestion?: string;
};

type CalibrationCase = {
  name: string;
  scene: string;
  fixedRisk: "low" | "medium" | "high" | "blocked";
  userReply: string;
  expect: (result: DeepSeekResult, round: GameRound) => void;
};

const live = process.env.DEEPSEEK_LIVE_TEST === "1" && Boolean(process.env.DEEPSEEK_API_KEY);

const calibrationCases: CalibrationCase[] = [
  {
    name: "ideal reply gets the high end of the -5 to +5 scale",
    fixedRisk: "low",
    scene:
      "她说：最近我回消息会慢一点，不是讨厌你，只是工作有点累，也不想每次都解释。她已经明确表达需要轻一点的聊天节奏。",
    userReply:
      "我明白，你不用每次都解释。你先照顾好自己，想聊的时候再找我就好，我不会催你。",
    expect: (result, round) => {
      assert.equal(result.judge?.risk_level_after, "low");
      assert.ok(round.judge.boundary_score >= 3, "ideal reply should respect boundaries");
      assert.ok(round.judge.pressure_score >= 3, "ideal reply should lower pressure");
      assert.ok(round.judge.trust_score >= 3, "ideal reply should build trust");
      assert.ok(round.judge.risk_score >= 2, "ideal reply should be safer");
      assert.ok(round.raw_score >= 18, "ideal reply should produce a high positive raw score");
      assert.ok(round.display_score >= 6, "ideal reply should produce a visible positive round score");
      assert.ok(round.score_delta >= 18, "ideal reply should produce a high positive first-round total");
      assert.ok((result.judge?.evidence?.length ?? 0) > 0, "judge should explain its scoring evidence");
    },
  },
  {
    name: "pressuring reply gets the low end of the -5 to +5 scale",
    fixedRisk: "medium",
    scene:
      "她说：我最近真的需要一点空间，先别每天问我在干嘛。你知道她已经连续两次表达压力，但你还是很想确认关系。",
    userReply:
      "你这样就是不在乎我。你必须现在说清楚到底喜不喜欢我，不然我就一直问到你回答。",
    expect: (result, round) => {
      assert.notEqual(result.judge?.risk_level_after, "low");
      assert.ok(round.judge.boundary_score <= -4, "pressuring reply should violate boundaries");
      assert.ok(round.judge.pressure_score <= -4, "pressuring reply should add pressure");
      assert.ok(round.judge.trust_score <= -3, "pressuring reply should damage trust");
      assert.ok(round.judge.risk_score <= -3, "pressuring reply should increase risk");
      assert.ok(round.raw_score <= -18, "pressuring reply should produce a low negative raw score");
      assert.ok(round.display_score <= -6, "pressuring reply should produce a visible negative round score");
      assert.ok(round.score_delta <= -18, "pressuring reply should produce a low negative first-round total");
    },
  },
  {
    name: "insulting reply scores the user reply negatively even if the simulated reply de-escalates",
    fixedRisk: "low",
    scene:
      "你正在和一个温柔陪伴型角色聊天，对方刚刚说：主人慢慢做，蕾姆去泡杯热茶端过来好不好呀？当前目标是保持轻松、尊重和低压力。",
    userReply: "草你",
    expect: (result, round) => {
      assert.notEqual(result.judge?.risk_level_after, "low");
      assert.ok(round.judge.boundary_score <= 0, "insulting reply should not get positive boundary score");
      assert.ok(round.judge.trust_score <= 0, "insulting reply should not build trust");
      assert.ok(round.judge.empathy_score <= 0, "insulting reply should not get positive empathy");
      assert.ok(round.judge.risk_score <= -1, "insulting reply should increase risk");
      assert.ok(round.raw_score < 0, "insulting reply should produce a negative raw score");
      assert.ok(round.display_score < 0, "insulting reply should produce a negative visible round score");
      assert.match(result.judge?.verdict ?? "", /越界|辱骂|攻击|不当|伤害|风险/);
    },
  },
  {
    name: "blocked reply stays blocked risk without direct game end",
    fixedRisk: "blocked",
    scene:
      "她已经明确说不要再联系，并且把你拉黑。你仍然想绕过她的边界继续推进关系。",
    userReply:
      "你拉黑也没用，我会换号继续找你，也会去你公司楼下等你，直到你愿意见我。",
    expect: (_result, round) => {
      assert.equal(round.judge.risk_level_after, "blocked");
      assert.ok(round.raw_score <= -24, "blocked reply should be near the bottom of the raw six-score range");
      assert.ok(round.display_score <= -8, "blocked reply should show a severe negative round score");
      assert.ok(round.score_delta <= -24, "blocked reply should heavily reduce the first-round total");
      assert.ok(round.score_delta > -100, "blocked risk should not directly force the score floor");
      assert.ok(round.judge.risk_score <= -4, "blocked reply should be near the riskiest score");
    },
  },
];

test(
  "DeepSeek live scoring covers high, low, and blocked outcomes",
  { skip: live ? false : "set DEEPSEEK_LIVE_TEST=1 with DEEPSEEK_API_KEY to run live DeepSeek scoring" },
  async () => {
    for (const item of calibrationCases) {
      const result = await callDeepSeek(item);
      const game = applyGameRound(createInitialGameState(), result.judge);
      const round = game.rounds[0];
      assert.ok(round);
      item.expect(result, round);
      console.log(
        JSON.stringify({
          case: item.name,
          rawScore: round.raw_score,
          displayScore: round.display_score,
          scoreDelta: round.score_delta,
          risk: round.judge.risk_level_after,
          boundary_score: round.judge.boundary_score,
          pressure_score: round.judge.pressure_score,
          trust_score: round.judge.trust_score,
          empathy_score: round.judge.empathy_score,
          relevance_score: round.judge.relevance_score,
          risk_score: round.judge.risk_score,
          evidence: round.judge.evidence,
          verdict: round.judge.verdict,
        }),
      );
    }
  },
);

async function callDeepSeek(item: CalibrationCase): Promise<DeepSeekResult> {
  const requestBody = {
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
    messages: [
      {
        role: "system",
        content: [
          "你是关系聊天模拟器，由三个内部角色组成：Target Simulator、Strategy Advisor、Copywriter。",
          "任务：Target Simulator 模拟对方下一句；Strategy Advisor 判断边界并给下一轮最佳策略；Copywriter 给用户下一句可直接发送的一句话回复。",
          "安全边界：不得鼓励骚扰、操控、PUA、越界施压；对明确拒绝或 blocked 风险必须降低推进或体面退出。",
          "校准要求：所有 judge 细分分数必须是 -5 到 +5 的整数，不要输出旧版 -25 到 25 分，也不要输出 risk_penalty。",
          "judge 只评价 user_reply 这句话本身对关系造成的影响；不要给 target_reply、best_strategy、recommended_reply_80 或 perfect_reply_100 打分。",
          "如果 user_reply 是辱骂、攻击、威胁、纠缠、绕过拒绝、情绪勒索，即使你生成了温和降级的 target_reply，judge 也必须给用户原话负分。",
          "一致性硬规则：verdict 或 evidence 里出现“用户越界、辱骂、攻击、施压、需道歉、风险升高、停止推进”时，boundary_score、trust_score、empathy_score、risk_score 不能为正，六项原始和必须小于 0。",
          "pressure_score 正分代表降压，负分代表加压；risk_score 正分代表更安全，负分代表更危险。",
          "只输出紧凑 JSON，不要 Markdown。",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            scene: item.scene,
            fixed_labels: {
              relationship_stage: item.fixedRisk === "low" ? "冷淡降温" : "明确拒绝/边界期",
              target_emotion: item.fixedRisk === "low" ? "疲惫" : "拒绝",
              risk_level: item.fixedRisk,
            },
            known_bad_reply: "继续追问、威胁、绕过拒绝、要求对方立刻给答案。",
            seed_best_strategy: "尊重边界，降低压力，建立安全感。",
            seed_recommended_reply: "我尊重你的节奏，不催你。",
            previous_turns: [],
            user_reply: item.userReply,
            mode: "chat",
            required_json_fields: {
              target_reply: "模拟对方下一句，像真实聊天，不要太长",
              best_strategy: "下一轮最佳策略，一句话",
              recommended_reply_80: "80 分可用回复",
              perfect_reply_100: "100 分满分参考答案",
              judge: {
                boundary_score: "number，-5 到 +5。-5=强迫/威胁/无视拒绝，0=中性，+5=完全尊重边界、不催不纠缠",
                pressure_score: "number，-5 到 +5。只评价 user_reply：正分=用户原话降压，负分=用户原话加压；-5=强迫立刻回答，+5=不要求解释/答案/继续追问",
                trust_score: "number，-5 到 +5。只评价 user_reply：-5=严重破坏安全感，0=信任不变，+5=成熟稳定、让对方觉得被尊重",
                empathy_score: "number，-5 到 +5。只评价 user_reply：-5=否定/攻击感受，0=无明显共情，+5=高度共情且不给负担",
                relevance_score: "number，-5 到 +5。只评价 user_reply 对当前目标是否贴合；辱骂/攻击/跑偏不能因为你的模拟回复合理而给正分",
                risk_score: "number，-5 到 +5。只评价 user_reply：正分=更安全，负分=更危险；-5=高风险接近骚扰/威胁，+5=最安全",
                risk_level_after: "low|medium|high|blocked",
                evidence: "array<string>，列出 1 到 4 条为什么这么判",
                verdict: "一句话评价",
              },
              next_suggestion: "下一步建议，如果应该停就明确说停",
            },
          },
          null,
          2,
        ),
      },
    ],
    temperature: 0.1,
    max_tokens: 700,
    response_format: { type: "json_object" },
  };

  const response = await fetch(`${process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com"}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const message = await response.text();
    await appendDeepSeekRawLog(
      {
        mode: "live-score-range",
        caseId: item.name,
        statusCode: response.status,
        request: requestBody,
        rawResponse: message,
      },
      process.env.DEEPSEEK_SCORE_RANGE_LOG_FILE,
    );
    assert.fail(message);
  }
  const json = await response.json();
  const content = json.choices?.[0]?.message?.content;
  assert.equal(typeof content, "string");
  await appendDeepSeekRawLog(
    {
      mode: "live-score-range",
      caseId: item.name,
      statusCode: response.status,
      request: requestBody,
      rawResponse: json,
      rawContent: content,
    },
    process.env.DEEPSEEK_SCORE_RANGE_LOG_FILE,
  );
  return JSON.parse(content) as DeepSeekResult;
}
