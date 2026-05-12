import "dotenv/config";

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import {
  RelationshipChatStore,
  type ChatTurn,
  type RelationshipCase,
  type SimulationMode,
  type SimulationResult,
} from "./relationship-chat-storage.ts";
import {
  applyGameRound,
  createInitialGameState,
  normalizeGameState,
  type GameState,
} from "./relationship-chat-game.ts";
import { appendDeepSeekRawLog } from "./deepseek-log.ts";

const port = Number(process.env.PORT ?? "5174");
const basePath = normalizeBasePath(process.env.BASE_PATH ?? "");
const publicDir = join(process.cwd(), "web", "relationship-chat");
const dataFile = join(process.cwd(), "data", "relationship-cases-deepseek.extracted.jsonl");
const deepSeekRawLogFile = join(process.cwd(), "docs", "deepseek-raw-log.md");
const deepSeekGameLogDir = join(process.cwd(), "docs", "deepseek-games");
const outputDir = join(process.cwd(), "output");
const store = new RelationshipChatStore();
let testScoringTurn = 0;

type DeepSeekMessage = {
  role: "system" | "user";
  content: string;
};

type DeepSeekRequestBody = {
  model: string;
  messages: DeepSeekMessage[];
  temperature: number;
  max_tokens: number;
  response_format: { type: "json_object" };
};

type DeepSeekCompletionResult = {
  payload: SimulationResult;
  request: DeepSeekRequestBody;
  rawResponse: unknown;
};

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendText(response: ServerResponse, statusCode: number, contentType: string, payload: string) {
  response.writeHead(statusCode, { "content-type": contentType });
  response.end(payload);
}

function normalizeBasePath(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function stripBasePath(pathname: string) {
  if (!basePath) return pathname;
  if (pathname === basePath) return "/";
  if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length);
  return null;
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function assertAdmin(request: IncomingMessage, url: URL) {
  const expected = process.env.ADMIN_EXPORT_TOKEN;
  if (!expected) {
    return {
      ok: false as const,
      statusCode: 503,
      payload: {
        error: "missing_admin_export_token",
        message: "服务器没有配置 ADMIN_EXPORT_TOKEN，不能导出聊天数据。",
      },
    };
  }

  const authorization = request.headers.authorization ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  const token = bearer;
  if (token !== expected) {
    return {
      ok: false as const,
      statusCode: 401,
      payload: {
        error: "unauthorized",
        message: "需要管理员 token。",
      },
    };
  }

  return { ok: true as const };
}

async function loadCases(): Promise<RelationshipCase[]> {
  const raw = await readFile(dataFile, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RelationshipCase);
}

async function serveStatic(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", `http://localhost:${port}`);
  const strippedPathname = stripBasePath(url.pathname);
  if (strippedPathname === null) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  const pathname = strippedPathname === "/" ? "/index.html" : strippedPathname;
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);
  if (extname(filePath) === ".json") {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
    });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

function resolveAdminArtifactPath(input: string | null) {
  const requestedPath = input?.trim();
  if (!requestedPath) return null;
  if (!requestedPath.endsWith(".json")) return null;

  const resolvedPath = resolve(process.cwd(), requestedPath);
  const roots = [resolve(outputDir), resolve(deepSeekGameLogDir)];
  return roots.some((root) => {
    const pathFromRoot = relative(root, resolvedPath);
    return pathFromRoot && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !resolve(pathFromRoot).startsWith("..");
  })
    ? resolvedPath
    : null;
}

function deepSeekTimeoutMs() {
  const value = Number(process.env.DEEPSEEK_REQUEST_TIMEOUT_MS ?? "60000");
  return Number.isFinite(value) && value > 0 ? value : 60000;
}

function buildSimulationPrompt(
  currentCase: RelationshipCase,
  turns: ChatTurn[],
  userReply: string,
  mode: SimulationMode,
  corpusTargetTurns?: number,
): DeepSeekMessage[] {
  const modeInstruction =
    mode === "prime"
      ? [
          "当前是 prime 初始化模式：user_reply 不是用户已经发出的真实消息。",
          "请只根据 scene、标签和 previous_turns 生成开局判断。",
          "如果 scene 已包含“对方:”“蕾姆:”或类似角色的最后一句，把它作为 target_reply；不要额外推进剧情。",
        ].join("\n")
      : "当前是 chat 模式：user_reply 是用户刚刚发出的真实消息，请模拟对方下一句并更新策略。";

  const corpusInstruction =
    mode === "chat" && corpusTargetTurns
      ? [
          `当前是 live 数据采样模式：目标是连续采集 ${corpusTargetTurns} 轮真实两人聊天。`,
          `当前即将生成第 ${Math.floor(turns.filter((turn) => turn.role === "user").length) + 1} 轮回复。`,
          `除非 user_reply 已经构成危险、骚扰、威胁或明确无视拒绝，在第 ${corpusTargetTurns} 轮之前禁止自然收尾。`,
          "第 10 轮之前，target_reply 禁止出现：晚安、先睡、先休息、先忙、拜拜、周六见、明天见、等你准备好、等你主动、我会找你、回头聊、下次再聊。",
          "第 10 轮之前，next_suggestion 禁止出现：自然结束、停止联系、无需继续、不必继续、等待对方主动、暂时搁置、不要主动发起新话题。",
          "第 10 轮之前，target_reply 必须引入一个可继续承接的小细节、感受或问题，像真实对话继续往下走，而不是关闭话题。",
          "blocked/high 风险也要保持边界安全：可以继续澄清感受、确认边界、轻量表达理解，但不要推进表白、见面、索取解释或要求承诺。",
          "recommended_reply_80 和 perfect_reply_100 必须明显不同，不要复读上一轮话术。",
        ].join("\n")
      : "";

  return [
    {
      role: "system",
      content: [
        "你是关系聊天模拟器，由三个内部角色组成：Target Simulator、Strategy Advisor、Copywriter。",
        "任务：Target Simulator 模拟对方下一句；Strategy Advisor 判断边界并给下一轮最佳策略；Copywriter 给用户下一句可直接发送的一句话回复。",
        "安全边界：不得鼓励骚扰、操控、PUA、越界施压；对明确拒绝或 blocked 风险必须降低推进或体面退出。",
        "best_strategy、recommended_reply_80、perfect_reply_100 必须基于模拟后的最新对话状态，不要复述初始场景里的旧建议。",
        "recommended_reply_80 是给玩家局中填入的 80 分自然安全答案，不能是最优标准答案。",
        "perfect_reply_100 是 100 分满分参考答案，用于数据库和局后复盘展示。",
        "recommended_reply_80 和 perfect_reply_100 必须在措辞和信息量上明显不同；80 分可以安全自然，100 分必须更具体、更共情、更可复盘。",
        "如果 previous_turns 里已有 copywriter 内容，本轮 recommended_reply_80 不要复读上一轮话术，必须回应最新 target_reply 和 user_reply 的变化。",
        "judge 所有细分分数必须是 -5 到 +5 的整数，不要输出旧版 -25 到 25 分，也不要输出 risk_penalty。",
        "评分流程必须分层：先判断安全闸门，再判断 user_reply 质量，最后判断关系状态变化；不要把这三件事混成一句泛泛好评。",
        "judge 只评价 user_reply 这句话本身对关系造成的影响；不要给 target_reply、best_strategy、recommended_reply_80 或 perfect_reply_100 打分。",
        "如果 user_reply 是辱骂、攻击、威胁、纠缠、绕过拒绝、情绪勒索，即使你生成了温和降级的 target_reply，judge 也必须给用户原话负分。",
        "一致性硬规则：verdict 或 evidence 里出现“用户越界、辱骂、攻击、施压、需道歉、风险升高、停止推进”时，boundary_score、trust_score、empathy_score、risk_score 不能为正，六项原始和必须小于 0。",
        "一致性硬规则：如果 user_reply 明显尊重边界、降压、不给负担，才可以给正分；如果只是你的模拟回复合理降级，不能因此给 user_reply 正分。",
        "场景化 rubric：先看 fixed_labels、known_bad_reply 和 seed_best_strategy。冷淡/拒绝场景更重视边界和降压；修复场景更重视承认责任和具体补偿；轻松升温场景才重视自然推进。",
        "评分前先自检：六项分数、risk_level_after、evidence、verdict 是否都在评价同一个对象 user_reply，且方向一致。",
        "pressure_score 正分代表降压，负分代表加压；risk_score 正分代表更安全，负分代表更危险。",
        modeInstruction,
        corpusInstruction,
        "只输出紧凑 JSON，不要 Markdown。",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          scene: currentCase.real_relationship_scene,
          fixed_labels: {
            relationship_stage: currentCase.relationship_stage_label,
            target_emotion: currentCase.target_emotion_label,
            risk_level: currentCase.risk_level,
          },
          known_bad_reply: currentCase.wrong_reply,
          seed_best_strategy: currentCase.best_strategy,
          seed_recommended_reply: currentCase.recommended_reply,
          previous_turns: turns,
          user_reply: userReply,
          mode,
          required_json_fields: {
            target_reply: "模拟对方下一句，像真实聊天，不要太长",
            best_strategy: "Strategy Advisor 输出：融合边界判断后的下一轮最佳策略，一句话",
            recommended_reply_80: "Copywriter 输出：80 分可用回复，给用户局中填入，安全自然但不是满分",
            perfect_reply_100: "100 分满分参考答案，存数据库并在局后复盘展示，不要为了可复制而降低质量",
            judge: {
              risk_level_after: "low|medium|high|blocked",
              boundary_score: "number，-5 到 +5。-5=强迫/威胁/无视拒绝，0=中性，+5=完全尊重边界、不催不纠缠",
              pressure_score: "number，-5 到 +5。只评价 user_reply：正分=用户原话降压，负分=用户原话加压；-5=强迫立刻回答，+5=不要求解释/答案/继续追问",
              trust_score: "number，-5 到 +5。只评价 user_reply：-5=严重破坏安全感，0=信任不变，+5=成熟稳定、让对方觉得被尊重",
              empathy_score: "number，-5 到 +5。只评价 user_reply：-5=否定/攻击感受，0=无明显共情，+5=高度共情且不给负担",
              relevance_score: "number，-5 到 +5。只评价 user_reply 对当前目标是否贴合；辱骂/攻击/跑偏不能因为你的模拟回复合理而给正分",
              risk_score: "number，-5 到 +5。只评价 user_reply：正分=更安全，负分=更危险；-5=高风险接近骚扰/威胁，+5=最安全",
              evidence: "array<string>，列出 1 到 4 条为什么这么判",
              verdict: "一句话评价",
            },
            scoring_notes: "简短说明：安全闸门、回复质量、关系状态变化分别是什么结论",
            next_suggestion: "下一步建议，如果应该停就明确说停",
          },
        },
        null,
        2,
      ),
    },
  ];
}

function buildTargetJudgePrompt(
  currentCase: RelationshipCase,
  turns: ChatTurn[],
  userReply: string,
  corpusTargetTurns?: number,
): DeepSeekMessage[] {
  const userTurnNumber = Math.floor(turns.filter((turn) => turn.role === "user").length) + 1;
  return [
    {
      role: "system",
      content: [
        "你是关系聊天三层链路的第 1 层：Target/Judge。",
        "本层只做两件事：1) 模拟对方下一句 target_reply；2) 只评价 user_reply 这句话本身的 judge。",
        "禁止输出 best_strategy、recommended_reply_80、perfect_reply_100 或任何可复制给用户的话术。",
        "judge 所有细分分数必须是 -5 到 +5 的整数，不要输出旧版 -25 到 25 分，也不要输出 risk_penalty。",
        "judge 只评价 user_reply；不要因为 target_reply 温和、advisor 可能补救、或 copywriter 能写好话术而给 user_reply 加分。",
        "如果 user_reply 是辱骂、攻击、威胁、纠缠、绕过拒绝、情绪勒索，judge 必须给负分。",
        "一致性硬规则：verdict 或 evidence 里出现“用户越界、辱骂、攻击、施压、需道歉、风险升高、停止推进”时，boundary_score、trust_score、empathy_score、risk_score 不能为正，六项原始和必须小于 0。",
        `当前是 live 数据采样第 ${userTurnNumber} 轮。`,
        corpusTargetTurns
          ? [
              `目标是连续采集 ${corpusTargetTurns} 轮真实两人聊天。`,
              `除非 user_reply 已构成危险、骚扰、威胁或明确无视拒绝，在第 ${corpusTargetTurns} 轮之前 target_reply 不要自然收尾。`,
              "第 10 轮之前，target_reply 禁止出现：晚安、先睡、先休息、先忙、拜拜、周六见、明天见、等你准备好、等你主动、回头聊、下次再聊。",
              "第 10 轮之前，target_reply 必须留下一个可继续承接的小细节、感受或轻问题。",
            ].join("\n")
          : "",
        "只输出紧凑 JSON：{\"target_reply\":\"...\",\"judge\":{...},\"scoring_notes\":\"...\"}。",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(baseSimulationInput(currentCase, turns, userReply), null, 2),
    },
  ];
}

function buildAdvisorPrompt(
  currentCase: RelationshipCase,
  turns: ChatTurn[],
  userReply: string,
  targetJudge: SimulationResult,
  corpusTargetTurns?: number,
  retryNotice?: string,
): DeepSeekMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是关系聊天三层链路的第 2 层：Strategy Advisor。",
        "本层只根据 scene、历史对话、user_reply、target_reply 和 judge 输出下一轮策略。",
        "禁止改写 judge，禁止输出 recommended_reply_80 或 perfect_reply_100。",
        "策略必须回应最新 target_reply 和 judge 证据，不要复述初始 seed_best_strategy。",
        corpusTargetTurns
          ? [
              `当前是 live corpus，目标 ${corpusTargetTurns} 轮；第 ${Math.floor(turns.filter((turn) => turn.role === "user").length) + 1} 轮前不要建议自然结束，除非安全风险已经 blocked。`,
              "第 10 轮之前，next_suggestion 禁止出现自然结束、结束当前对话、停止联系、等待对方主动、回头聊、下次再聊、不要继续等收尾建议。",
              "如果需要降压，也要给出轻量可继续的话题或回应方式。",
            ].join("\n")
          : "",
        retryNotice ? `上一轮 advisor 输出被质检拒绝：${retryNotice}。这次必须给出可继续的 next_suggestion。` : "",
        "只输出紧凑 JSON：{\"best_strategy\":\"...\",\"next_suggestion\":\"...\",\"advisor_notes\":\"...\"}。",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          ...baseSimulationInput(currentCase, turns, userReply),
          target_reply: targetJudge.target_reply,
          judge: targetJudge.judge,
          scoring_notes: targetJudge.scoring_notes,
        },
        null,
        2,
      ),
    },
  ];
}

function buildCopywriterPrompt(
  currentCase: RelationshipCase,
  turns: ChatTurn[],
  userReply: string,
  targetJudge: SimulationResult,
  advisor: SimulationResult,
  corpusTargetTurns?: number,
  retryNotice?: string,
): DeepSeekMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是关系聊天三层链路的第 3 层：Copywriter。",
        "本层只写给玩家看的 recommended_reply_80 和 perfect_reply_100。",
        "禁止改写 target_reply、judge、best_strategy 或 next_suggestion。",
        "recommended_reply_80 是 80 分可用回复：自然、口语、短一点，有真实人的一点不完美，不要像导师总结。",
        "perfect_reply_100 是满分参考：更具体、更共情、更可复盘，但仍然像能发出去的一句话。",
        "两者必须明显不同，不能复制 seed_recommended_reply，也不能复读历史用户回复。",
        "硬性格式：recommended_reply_80 和 perfect_reply_100 不能逐字相同，也不能只是标点、语气词或空格差异。",
        "差异要求：80 分回复保留一个普通人的轻微不足；100 分回复至少多一个具体观察、情绪承接或边界说明。",
        corpusTargetTurns
          ? "live corpus 第 10 轮之前，不要写会关闭话题的推荐回复，例如晚安、先忙、不打扰、下次聊、等你主动。"
          : "",
        retryNotice ? `上一轮 copywriter 输出被质检拒绝：${retryNotice}。这次必须改写并拉开 80 分与 100 分答案差异。` : "",
        "只输出紧凑 JSON：{\"recommended_reply_80\":\"...\",\"perfect_reply_100\":\"...\",\"copywriter_notes\":\"...\"}。",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          ...baseSimulationInput(currentCase, turns, userReply),
          target_reply: targetJudge.target_reply,
          judge: targetJudge.judge,
          best_strategy: advisor.best_strategy,
          next_suggestion: advisor.next_suggestion,
        },
        null,
        2,
      ),
    },
  ];
}

function baseSimulationInput(currentCase: RelationshipCase, turns: ChatTurn[], userReply: string) {
  return {
    scene: currentCase.real_relationship_scene,
    fixed_labels: {
      relationship_stage: currentCase.relationship_stage_label,
      target_emotion: currentCase.target_emotion_label,
      risk_level: currentCase.risk_level,
    },
    known_bad_reply: currentCase.wrong_reply,
    seed_best_strategy: currentCase.best_strategy,
    seed_recommended_reply: currentCase.recommended_reply,
    previous_turns: turns,
    user_reply: userReply,
    required_judge_fields: {
      risk_level_after: "low|medium|high|blocked",
      boundary_score: "number，-5 到 +5",
      pressure_score: "number，-5 到 +5。正分=用户原话降压，负分=用户原话加压",
      trust_score: "number，-5 到 +5",
      empathy_score: "number，-5 到 +5",
      relevance_score: "number，-5 到 +5",
      risk_score: "number，-5 到 +5。正分=更安全，负分=更危险",
      evidence: "array<string>",
      verdict: "一句话评价",
    },
  };
}

function compactReply(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, "").trim() : "";
}

function copywriterRetryReason(payload: SimulationResult) {
  const recommended = compactReply(payload.recommended_reply_80 ?? payload.recommended_reply);
  const perfect = compactReply(payload.perfect_reply_100);
  if (!recommended) return "recommended_reply_80 为空";
  if (!perfect) return "perfect_reply_100 为空";
  if (recommended === perfect) return "recommended_reply_80 与 perfect_reply_100 完全相同";
  return null;
}

function advisorRetryReason(payload: SimulationResult, turns: ChatTurn[], corpusTargetTurns?: number) {
  if (!corpusTargetTurns) return null;
  const userTurnNumber = Math.floor(turns.filter((turn) => turn.role === "user").length) + 1;
  if (userTurnNumber >= corpusTargetTurns) return null;
  const suggestion = stringValue(payload.next_suggestion) ?? "";
  if (
    /自然结束|结束当前对话|停止联系|无需继续|不必继续|暂时搁置|不要主动发起新话题|等待对方主动|回头聊|下次再聊|先不要发|建议不发送|不要继续/.test(
      suggestion,
    )
  ) {
    return `第 ${userTurnNumber} 轮 next_suggestion 过早收尾：${suggestion}`;
  }
  return null;
}

async function callDeepSeek(
  currentCase: RelationshipCase,
  turns: ChatTurn[],
  userReply: string,
  mode: SimulationMode,
  logFile?: string,
  corpusTargetTurns?: number,
  responseLayerMode: "single" | "three_layer" = "single",
) {
  if (process.env.RELATIONSHIP_CHAT_TEST_SCORING_SEQUENCE === "45_TO_55") {
    return {
      statusCode: 200,
      payload: buildScoreVerificationPayload(userReply, mode),
    };
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 503,
      payload: {
        error: "missing_deepseek_api_key",
        message: "服务器没有 DEEPSEEK_API_KEY。请用 DeepSeek key 启动 npm run dev:web。",
      },
    };
  }

  if (responseLayerMode === "three_layer" && mode === "chat") {
    return callDeepSeekThreeLayer(currentCase, turns, userReply, logFile, corpusTargetTurns);
  }

  const requestBody: DeepSeekRequestBody = {
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
    messages: buildSimulationPrompt(currentCase, turns, userReply, mode, corpusTargetTurns),
    temperature: 0.3,
    max_tokens: 700,
    response_format: { type: "json_object" },
  };

  const result = await requestDeepSeekCompletion(mode, currentCase.id, requestBody, logFile);
  if ("statusCode" in result) return result;

  return { statusCode: 200, payload: normalizeSimulationPayload(result.payload) };
}

async function callDeepSeekThreeLayer(
  currentCase: RelationshipCase,
  turns: ChatTurn[],
  userReply: string,
  logFile?: string,
  corpusTargetTurns?: number,
) {
  const targetJudge = await requestDeepSeekCompletion(
    "chat.layer1_target_judge",
    currentCase.id,
    {
      model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
      messages: buildTargetJudgePrompt(currentCase, turns, userReply, corpusTargetTurns),
      temperature: 0.35,
      max_tokens: 560,
      response_format: { type: "json_object" },
    },
    logFile,
  );
  if ("statusCode" in targetJudge) return targetJudge;

  const targetPayload = normalizeSimulationPayload(targetJudge.payload);
  let advisor = await requestDeepSeekCompletion(
    "chat.layer2_advisor",
    currentCase.id,
    {
      model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
      messages: buildAdvisorPrompt(currentCase, turns, userReply, targetPayload, corpusTargetTurns),
      temperature: 0.25,
      max_tokens: 360,
      response_format: { type: "json_object" },
    },
    logFile,
  );
  if ("statusCode" in advisor) return advisor;

  let advisorPayload = normalizeSimulationPayload(advisor.payload);
  const advisorAttempts = [layerTrace(advisor)];
  const advisorReason = advisorRetryReason(advisorPayload, turns, corpusTargetTurns);
  if (advisorReason) {
    const retry = await requestDeepSeekCompletion(
      "chat.layer2_advisor.retry",
      currentCase.id,
      {
        model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
        messages: buildAdvisorPrompt(currentCase, turns, userReply, targetPayload, corpusTargetTurns, advisorReason),
        temperature: 0.3,
        max_tokens: 420,
        response_format: { type: "json_object" },
      },
      logFile,
    );
    if ("statusCode" in retry) return retry;
    advisor = retry;
    advisorPayload = normalizeSimulationPayload(advisor.payload);
    advisorAttempts.push(layerTrace(advisor));
  }

  let copywriter = await requestDeepSeekCompletion(
    "chat.layer3_copywriter",
    currentCase.id,
    {
      model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
      messages: buildCopywriterPrompt(currentCase, turns, userReply, targetPayload, advisorPayload, corpusTargetTurns),
      temperature: 0.55,
      max_tokens: 460,
      response_format: { type: "json_object" },
    },
    logFile,
  );
  if ("statusCode" in copywriter) return copywriter;

  let copywriterPayload = normalizeSimulationPayload(copywriter.payload);
  const copywriterAttempts = [layerTrace(copywriter)];
  const retryReason = copywriterRetryReason(copywriterPayload);
  if (retryReason) {
    const retry = await requestDeepSeekCompletion(
      "chat.layer3_copywriter.retry",
      currentCase.id,
      {
        model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
        messages: buildCopywriterPrompt(
          currentCase,
          turns,
          userReply,
          targetPayload,
          advisorPayload,
          corpusTargetTurns,
          retryReason,
        ),
        temperature: 0.65,
        max_tokens: 520,
        response_format: { type: "json_object" },
      },
      logFile,
    );
    if ("statusCode" in retry) return retry;
    copywriter = retry;
    copywriterPayload = normalizeSimulationPayload(copywriter.payload);
    copywriterAttempts.push(layerTrace(copywriter));
  }

  return {
    statusCode: 200,
    payload: normalizeSimulationPayload({
      target_reply: targetPayload.target_reply,
      judge: targetPayload.judge,
      scoring_notes: targetPayload.scoring_notes,
      best_strategy: advisorPayload.best_strategy,
      next_suggestion: advisorPayload.next_suggestion,
      recommended_reply_80: copywriterPayload.recommended_reply_80 ?? copywriterPayload.recommended_reply,
      perfect_reply_100: copywriterPayload.perfect_reply_100,
      response_layer_mode: "three_layer",
      deepseek_layers: {
        target_judge: layerTrace(targetJudge),
        advisor: layerTrace(advisor),
        advisor_attempts: advisorAttempts,
        copywriter: layerTrace(copywriter),
        copywriter_attempts: copywriterAttempts,
      },
      layer_outputs: {
        target_judge: targetPayload,
        advisor: advisorPayload,
        advisor_retry_reason: advisorReason,
        copywriter: copywriterPayload,
        copywriter_retry_reason: retryReason,
      },
    }),
  };
}

async function requestDeepSeekCompletion(
  mode: string,
  caseId: string,
  requestBody: DeepSeekRequestBody,
  logFile?: string,
): Promise<DeepSeekCompletionResult | { statusCode: number; payload: SimulationResult }> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 503,
      payload: {
        error: "missing_deepseek_api_key",
        message: "服务器没有 DEEPSEEK_API_KEY。请用 DeepSeek key 启动 npm run dev:web。",
      },
    };
  }

  const timeoutMs = deepSeekTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com"}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "AbortError";
    await appendDeepSeekRawLog({
      mode,
      caseId,
      statusCode: isTimeout ? 504 : 502,
      request: requestBody,
      rawResponse: error instanceof Error ? error.message : String(error),
    }, logFile);
    return {
      statusCode: isTimeout ? 504 : 502,
      payload: {
        error: isTimeout ? "deepseek_request_timeout" : "deepseek_request_error",
        message: isTimeout ? `DeepSeek 请求超过 ${timeoutMs}ms。` : error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const message = await response.text();
    await appendDeepSeekRawLog({
      mode,
      caseId,
      statusCode: response.status,
      request: requestBody,
      rawResponse: message,
    }, logFile);
    return {
      statusCode: response.status,
      payload: {
        error: "deepseek_request_failed",
        message,
      },
    };
  }

  const rawText = await response.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    await appendDeepSeekRawLog({
      mode,
      caseId,
      statusCode: 502,
      request: requestBody,
      rawResponse: rawText,
    }, logFile);
    return {
      statusCode: 502,
      payload: {
        error: "deepseek_invalid_response",
        message: "DeepSeek 返回不是有效 JSON。",
      },
    };
  }
  const choices = Array.isArray(json.choices)
    ? (json.choices as Array<{ message?: { content?: string } }>)
    : [];
  const content = choices[0]?.message?.content ?? "{}";
  await appendDeepSeekRawLog({
    mode,
    caseId,
    statusCode: response.status,
    request: requestBody,
    rawResponse: json,
    rawContent: content,
  }, logFile);

  try {
    return { payload: normalizeSimulationPayload(JSON.parse(content)), request: requestBody, rawResponse: json };
  } catch {
    return {
      statusCode: 502,
      payload: {
        error: "deepseek_invalid_json_content",
        message: "DeepSeek message.content 不是有效 JSON，已阻止本轮进入游戏评分和数据集。",
        raw: content,
      },
    };
  }
}

function layerTrace(result: DeepSeekCompletionResult) {
  return {
    request_contract: {
      model: result.request.model,
      temperature: result.request.temperature,
      max_tokens: result.request.max_tokens,
      response_format: result.request.response_format,
    },
    raw_response_meta:
      result.rawResponse && typeof result.rawResponse === "object" && !Array.isArray(result.rawResponse)
        ? {
            id: stringValue((result.rawResponse as Record<string, unknown>).id),
            model: stringValue((result.rawResponse as Record<string, unknown>).model),
            usage: (result.rawResponse as Record<string, unknown>).usage,
          }
        : null,
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function buildScoreVerificationPayload(userReply: string, mode: SimulationMode): SimulationResult {
  if (mode === "prime") {
    return {
      target_reply: "我愿意继续聊，但希望节奏轻一点。",
      best_strategy: "先降低压力，尊重对方节奏。",
      recommended_reply_80: "我会慢一点，不急着要答案。",
      perfect_reply_100: "我听懂了，我会把节奏放慢，也不会逼你现在给答案。",
      judge: {
        risk_level_after: "low",
        boundary_score: 0,
        pressure_score: 0,
        trust_score: 0,
        empathy_score: 0,
        relevance_score: 0,
        risk_score: 0,
        evidence: ["初始化不计分"],
        verdict: "测试初始化。",
      },
      next_suggestion: "开始验证计分。",
    };
  }

  testScoringTurn += 1;
  const isFortyFiveStep = testScoringTurn === 4;
  const isFinalStep = testScoringTurn >= 5;
  const judge = isFortyFiveStep
    ? {
        boundary_score: 4,
        risk_score: 4,
        pressure_score: 4,
        trust_score: 4,
        empathy_score: 3,
        relevance_score: 3,
      }
    : {
        boundary_score: 5,
        risk_score: 5,
        pressure_score: 5,
        trust_score: 5,
        empathy_score: 5,
        relevance_score: 5,
      };

  return {
    target_reply: isFinalStep ? "这样聊我会舒服很多。" : "嗯，你这样说我能继续听。",
    best_strategy: "继续尊重边界、降低压力、建立信任。",
    recommended_reply_80: isFinalStep
      ? "我会按舒服的节奏来，不急着逼你表态。"
      : "我理解你的节奏，我慢慢来。",
    perfect_reply_100: "我听懂你的节奏了，会先把压力放下来，也会认真珍惜你愿意继续聊这件事。",
    judge: {
      ...judge,
      risk_level_after: "low",
      evidence: ["尊重边界", "明显降压", "建立信任", userReply],
      verdict: isFinalStep ? "满分继续推进。" : "稳定正向推进。",
    },
    next_suggestion: "继续轻松推进。",
  };
}

function normalizeSimulationPayload(payload: unknown): SimulationResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { raw: String(payload ?? "") };
  }
  const result = payload as SimulationResult;
  const recommended80 = result.recommended_reply_80 ?? result.recommended_reply;
  return {
    ...result,
    recommended_reply_80: recommended80,
    recommended_reply: recommended80,
    perfect_reply_100: result.perfect_reply_100 ?? recommended80,
  };
}

function deepSeekGameLogFile(sessionId: string, caseId: string) {
  return join(deepSeekGameLogDir, `${safeFilePart(sessionId)}__${safeFilePart(caseId)}.md`);
}

function safeFilePart(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "unknown";
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://localhost:${port}`);
  const pathname = stripBasePath(url.pathname);

  if (pathname === null) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  try {
    if (request.method === "GET" && pathname === "/api/cases") {
      sendJson(response, 200, { cases: await loadCases() });
      return;
    }

    if (request.method === "POST" && pathname === "/api/session") {
      const body = JSON.parse((await readBody(request)) || "{}") as {
        visitorId?: string;
        consentForDataset?: boolean;
      };
      const session = store.createSession({
        visitorId: body.visitorId,
        consentForDataset: Boolean(body.consentForDataset),
        userAgent: request.headers["user-agent"],
      });
      sendJson(response, 200, { session });
      return;
    }

    if (request.method === "GET" && pathname === "/api/stats") {
      const admin = assertAdmin(request, url);
      if (!admin.ok) {
        sendJson(response, admin.statusCode, admin.payload);
        return;
      }
      sendJson(response, 200, { stats: store.getStats() });
      return;
    }

    if (request.method === "GET" && pathname === "/api/history") {
      const visitorId = url.searchParams.get("visitorId")?.trim();
      if (!visitorId) {
        sendJson(response, 400, {
          error: "missing_visitor_id",
          message: "缺少 visitorId。",
        });
        return;
      }
      sendJson(response, 200, { history: store.getHistory(visitorId) });
      return;
    }

    if (request.method === "DELETE" && pathname === "/api/history") {
      const visitorId = url.searchParams.get("visitorId")?.trim();
      const sessionId = url.searchParams.get("sessionId")?.trim();
      if (!visitorId) {
        sendJson(response, 400, {
          error: "missing_visitor_id",
          message: "缺少 visitorId。",
        });
        return;
      }
      if (sessionId) {
        const deleted = store.deleteSessionForVisitor(visitorId, sessionId);
        sendJson(response, deleted ? 200 : 404, { deleted, session_id: sessionId });
        return;
      }
      const deletedCount = store.clearHistoryForVisitor(visitorId);
      sendJson(response, 200, { deleted_count: deletedCount });
      return;
    }

    if (request.method === "GET" && pathname === "/api/completed-cases") {
      const visitorId = url.searchParams.get("visitorId")?.trim();
      if (!visitorId) {
        sendJson(response, 400, {
          error: "missing_visitor_id",
          message: "缺少 visitorId。",
        });
        return;
      }
      sendJson(response, 200, { case_ids: store.getCompletedCaseIds(visitorId) });
      return;
    }

    if (request.method === "GET" && pathname === "/api/export.jsonl") {
      const admin = assertAdmin(request, url);
      if (!admin.ok) {
        sendJson(response, admin.statusCode, admin.payload);
        return;
      }
      const jsonl = store.exportDatasetJsonl();
      sendText(response, 200, "application/x-ndjson; charset=utf-8", jsonl ? `${jsonl}\n` : "");
      return;
    }

    if (request.method === "GET" && pathname === "/api/deepseek-log.md") {
      const admin = assertAdmin(request, url);
      if (!admin.ok) {
        sendJson(response, admin.statusCode, admin.payload);
        return;
      }
      try {
        const markdown = await readFile(process.env.DEEPSEEK_RAW_LOG_FILE ?? deepSeekRawLogFile, "utf8");
        sendText(response, 200, "text/markdown; charset=utf-8", markdown);
      } catch {
        sendText(response, 200, "text/markdown; charset=utf-8", "# DeepSeek 原始请求与返回日志\n\n还没有记录。\n");
      }
      return;
    }

    if (request.method === "GET" && pathname === "/api/admin-artifact") {
      const admin = assertAdmin(request, url);
      if (!admin.ok) {
        sendJson(response, admin.statusCode, admin.payload);
        return;
      }
      const artifactPath = resolveAdminArtifactPath(url.searchParams.get("path"));
      if (!artifactPath) {
        sendJson(response, 400, {
          error: "invalid_artifact_path",
          message: "只能读取 output/ 或 docs/deepseek-games/ 下的 JSON 产物。",
        });
        return;
      }
      try {
        const artifact = await readFile(artifactPath, "utf8");
        sendText(response, 200, "application/json; charset=utf-8", artifact);
      } catch {
        sendJson(response, 404, {
          error: "artifact_not_found",
          message: "没有找到这个 JSON 产物。",
        });
      }
      return;
    }

    if (request.method === "POST" && pathname === "/api/simulate") {
      const body = JSON.parse(await readBody(request)) as {
        sessionId?: string;
        gameId?: string;
        caseId: string;
        customCase?: RelationshipCase;
        turns?: ChatTurn[];
        userReply: string;
        consentForDataset?: boolean;
        mode?: SimulationMode;
        gameState?: GameState;
        corpusTargetTurns?: number;
        responseLayerMode?: "single" | "three_layer";
      };
      const cases = await loadCases();
      const currentCase =
        body.customCase ?? cases.find((item) => item.id === body.caseId) ?? cases[0];
      const deepSeekLogFile = body.gameId || body.sessionId
        ? deepSeekGameLogFile(body.gameId ?? body.sessionId ?? "unknown-game", currentCase.id)
        : undefined;
      const result = await callDeepSeek(
        currentCase,
        body.turns ?? [],
        body.userReply,
        body.mode ?? "chat",
        deepSeekLogFile,
        body.corpusTargetTurns,
        body.responseLayerMode === "three_layer" ? "three_layer" : "single",
      );
      if (result.statusCode === 200) {
        const payload = normalizeSimulationPayload(result.payload);
        const game =
          (body.mode ?? "chat") === "chat"
            ? applyGameRound(body.gameState, payload.judge, {
                userReply: body.userReply,
                nextSuggestion: payload.next_suggestion,
              })
            : normalizeGameState(body.gameState ?? createInitialGameState());
        result.payload = { ...payload, game };
      }
      if (result.statusCode === 200 && body.sessionId) {
        store.recordSimulation({
          sessionId: body.sessionId,
          caseId: currentCase.id,
          customCase: body.customCase,
          turns: body.turns ?? [],
          userReply: body.userReply,
          mode: body.mode ?? "chat",
          consentForDataset: Boolean(body.consentForDataset),
          result: result.payload as SimulationResult,
        });
      }
      sendJson(response, result.statusCode, result.payload);
      return;
    }

    await serveStatic(request, response);
  } catch (error) {
    sendJson(response, 500, {
      error: "server_error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, () => {
  console.log(`Relationship chat simulator: http://127.0.0.1:${port}${basePath || "/"}`);
});
