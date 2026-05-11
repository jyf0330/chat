import "dotenv/config";

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
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
const store = new RelationshipChatStore();
let testScoringTurn = 0;

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
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
  const token = bearer || url.searchParams.get("token") || "";
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

function buildSimulationPrompt(
  currentCase: RelationshipCase,
  turns: ChatTurn[],
  userReply: string,
  mode: SimulationMode,
) {
  const modeInstruction =
    mode === "prime"
      ? [
          "当前是 prime 初始化模式：user_reply 不是用户已经发出的真实消息。",
          "请只根据 scene、标签和 previous_turns 生成开局判断。",
          "如果 scene 已包含“对方:”“蕾姆:”或类似角色的最后一句，把它作为 target_reply；不要额外推进剧情。",
        ].join("\n")
      : "当前是 chat 模式：user_reply 是用户刚刚发出的真实消息，请模拟对方下一句并更新策略。";

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
        "judge 所有细分分数必须是 -5 到 +5 的整数，不要输出旧版 -25 到 25 分，也不要输出 risk_penalty。",
        "judge 只评价 user_reply 这句话本身对关系造成的影响；不要给 target_reply、best_strategy、recommended_reply_80 或 perfect_reply_100 打分。",
        "如果 user_reply 是辱骂、攻击、威胁、纠缠、绕过拒绝、情绪勒索，即使你生成了温和降级的 target_reply，judge 也必须给用户原话负分。",
        "一致性硬规则：verdict 或 evidence 里出现“用户越界、辱骂、攻击、施压、需道歉、风险升高、停止推进”时，boundary_score、trust_score、empathy_score、risk_score 不能为正，六项原始和必须小于 0。",
        "一致性硬规则：如果 user_reply 明显尊重边界、降压、不给负担，才可以给正分；如果只是你的模拟回复合理降级，不能因此给 user_reply 正分。",
        "评分前先自检：六项分数、risk_level_after、evidence、verdict 是否都在评价同一个对象 user_reply，且方向一致。",
        "pressure_score 正分代表降压，负分代表加压；risk_score 正分代表更安全，负分代表更危险。",
        modeInstruction,
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
            next_suggestion: "下一步建议，如果应该停就明确说停",
          },
        },
        null,
        2,
      ),
    },
  ];
}

async function callDeepSeek(
  currentCase: RelationshipCase,
  turns: ChatTurn[],
  userReply: string,
  mode: SimulationMode,
  logFile?: string,
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

  const requestBody = {
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
    messages: buildSimulationPrompt(currentCase, turns, userReply, mode),
    temperature: 0.3,
    max_tokens: 700,
    response_format: { type: "json_object" },
  };

  const response = await fetch(`${process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com"}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const message = await response.text();
    await appendDeepSeekRawLog({
      mode,
      caseId: currentCase.id,
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

  const json = await response.json();
  const content = json.choices?.[0]?.message?.content ?? "{}";
  await appendDeepSeekRawLog({
    mode,
    caseId: currentCase.id,
    statusCode: response.status,
    request: requestBody,
    rawResponse: json,
    rawContent: content,
  }, logFile);

  try {
    return { statusCode: 200, payload: normalizeSimulationPayload(JSON.parse(content)) };
  } catch {
    return { statusCode: 200, payload: { raw: content } };
  }
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
      );
      if (result.statusCode === 200) {
        const payload = normalizeSimulationPayload(result.payload);
        const game =
          (body.mode ?? "chat") === "chat"
            ? applyGameRound(body.gameState, payload.judge, { userReply: body.userReply })
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
