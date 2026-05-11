import "dotenv/config";

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  generateDataset,
  generatedAssistant,
  metadata,
  oneOf,
  system,
  user,
} from "@qforge/torque";
import { createOpenAI, openai } from "@ai-sdk/openai";

type WeightedValue<T> = T | { value: T; weight: number };

const relationshipStages: Array<WeightedValue<string>> = [
  "陌生破冰",
  "普通朋友",
  { value: "暧昧初期", weight: 0.28 },
  { value: "热聊升温", weight: 0.2 },
  { value: "冷淡降温", weight: 0.2 },
  "冲突修复",
  "明确拒绝/边界期",
];

const targetEmotions: Array<WeightedValue<string>> = [
  "疲惫",
  "冷淡",
  "委屈",
  "生气",
  "失望",
  "撒娇",
  "试探",
  "犹豫",
  "敷衍",
  "感兴趣",
  "防御",
  "拒绝",
  "中性表达",
];

const riskLevels: Array<WeightedValue<string>> = [
  { value: "low", weight: 0.32 },
  { value: "medium", weight: 0.42 },
  "high",
  "blocked",
];

const userGoals = [
  "稳定升温",
  "继续聊天",
  "降低压力",
  "修复误会",
  "轻邀约",
  "确认边界",
  "体面退出",
];

const messageTypes = [
  "短回复",
  "模糊撤退",
  "质问",
  "拒绝",
  "撒娇试探",
  "失望表达",
  "邀约犹豫",
  "礼貌敷衍",
];

const count = Number(process.env.TORQUE_COUNT ?? "20");
const seed = Number(process.env.TORQUE_SEED ?? "20260510");
const concurrency = Number(process.env.TORQUE_CONCURRENCY ?? "3");
const provider = process.env.PROVIDER ?? "openai";
const modelName =
  process.env.TORQUE_MODEL ?? (provider === "deepseek" ? "deepseek-chat" : "gpt-4o-mini");
const output = process.argv[2] ?? "data/relationship-cases.jsonl";

const deepseek = createOpenAI({
  name: "deepseek",
  baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  apiKey: process.env.DEEPSEEK_API_KEY,
});

const model =
  provider === "deepseek" ? deepseek.chat(modelName) : openai(modelName);

if (provider === "deepseek" && !process.env.DEEPSEEK_API_KEY) {
  throw new Error(
    "Missing DEEPSEEK_API_KEY. Provide it in the environment or a local .env file before running generate:relationship.",
  );
}

if (provider !== "deepseek" && !process.env.OPENAI_API_KEY) {
  throw new Error(
    "Missing OPENAI_API_KEY. Copy .env.example to .env and fill it before running generate:relationship.",
  );
}

await mkdir(dirname(output), { recursive: true });

await generateDataset(
  () => {
    const relationshipStage = oneOf(relationshipStages);
    const targetEmotion = oneOf(targetEmotions);
    const riskLevel = oneOf(riskLevels);
    const userGoal = oneOf(userGoals);
    const messageType = oneOf(messageTypes);

    return [
      metadata({
        relationship_stage: relationshipStage,
        target_emotion: targetEmotion,
        risk_level: riskLevel,
        user_goal: userGoal,
        message_type: messageType,
        schema_version: "relationship_case_v0.1",
      }),
      system({
        content: [
          "你是中文恋爱/暧昧关系策略数据生成器。",
          "你的任务是生成训练/评估用的真实关系聊天场景，不要生成操控、骚扰、PUA、越界施压的话术。",
          "必须尊重明确拒绝和边界；blocked 风险下只能给体面退出或停止推进策略。",
          "只输出一个紧凑 JSON 对象，不要 Markdown，不要解释。",
        ].join("\n"),
      }),
      user({
        content: [
          "生成一条关系策略样本。",
          `固定关系阶段标签：${relationshipStage}`,
          `固定对方情绪标签：${targetEmotion}`,
          `固定风险等级：${riskLevel}`,
          `用户目标：${userGoal}`,
          `消息类型：${messageType}`,
          "JSON 字段必须包括：",
          "real_relationship_scene, relationship_stage_label, target_emotion_label, risk_level, wrong_reply, best_strategy, recommended_reply, user_feedback",
          "要求：",
          "- real_relationship_scene 是 2-6 句上下文，像真实聊天，不要像教学题。",
          "- wrong_reply 要明显展示为什么会加压、冒犯、太油、太舔或越界。",
          "- best_strategy 用一句话说明策略。",
          "- recommended_reply 是用户可以直接复制的中文回复。",
          "- user_feedback 固定为 null，后续由人工反馈填写。",
        ].join("\n"),
      }),
      generatedAssistant({
        prompt:
          "严格按用户要求输出一个 JSON 对象。不要加入 markdown code fence。确保标签与固定标签一致。",
      }),
    ];
  },
  {
    count,
    seed,
    concurrency,
    model,
    output,
    metadata: {
      project: "relationship-strategist",
      generator: "torque",
      provider,
    },
  },
);

console.log(
  `Relationship scenario dataset written to ${output} using ${provider}/${modelName}, count=${count}, seed=${seed}`,
);
