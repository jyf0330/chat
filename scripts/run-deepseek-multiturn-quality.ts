import "dotenv/config";

import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import type { ChatTurn, RelationshipCase, SimulationResult } from "./relationship-chat-storage.ts";

type QualityTurn = {
  turn: number;
  user_reply: string;
  previous_recommended_reply_80: string | null;
  matched_previous_recommendation: boolean;
  target_reply: string | null;
  recommended_reply_80: string | null;
  perfect_reply_100: string | null;
  next_suggestion: string | null;
  judge: unknown;
  game: SimulationResult["game"] | null;
  after_stop_suggestion: boolean;
};

type QualityGame = {
  player_id: string;
  session_id: string | null;
  case_id: string;
  scene: string;
  raw_log_file: string;
  completed: boolean;
  stop_reason: string | null;
  error: string | null;
  turns: QualityTurn[];
};

const outputJsonPath = "output/deepseek-multiturn-quality-live.json";
const outputMarkdownPath = "output/deepseek-multiturn-quality-live.md";
const casesPath = "data/relationship-cases-deepseek.extracted.jsonl";
const runId = process.env.RELATIONSHIP_CHAT_MULTITURN_RUN_ID ?? timestampRunId();
const deepSeekBaseUrl = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";

async function main() {
  if (process.env.RELATIONSHIP_CHAT_TEST_SCORING_SEQUENCE) {
    throw new Error("RELATIONSHIP_CHAT_TEST_SCORING_SEQUENCE is set; live multi-turn quality refuses fixture scoring.");
  }
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is missing.");
  assertOfficialOrAllowedDeepSeekEndpoint(deepSeekBaseUrl);

  mkdirSync("output", { recursive: true });
  mkdirSync(".cache", { recursive: true });
  mkdirSync("docs/deepseek-games", { recursive: true });

  const port = await getFreePort();
  const dbFile = resolve(".cache", `relationship-chat-multiturn-quality-${runId}.sqlite`);
  await rm(dbFile, { force: true });
  await rm(`${dbFile}-shm`, { force: true });
  await rm(`${dbFile}-wal`, { force: true });

  const server = startServer(port, dbFile);
  try {
    await waitForServer(port);
    const cases = readSeedCases();
    const games: QualityGame[] = [];
    for (const [index, plan] of plans.entries()) {
      games.push(await runGame({ baseUrl: `http://127.0.0.1:${port}`, plan, currentCase: cases[plan.caseIndex], index }));
    }
    const summary = summarize(games, dbFile, port);
    writeFileSync(outputJsonPath, JSON.stringify({ summary, games }, null, 2), "utf8");
    writeFileSync(outputMarkdownPath, buildMarkdown(summary, games), "utf8");
    console.log(`Wrote ${outputJsonPath}`);
    console.log(`Wrote ${outputMarkdownPath}`);
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.pass) process.exitCode = 1;
  } finally {
    await stopServer(server);
  }
}

async function runGame(input: {
  baseUrl: string;
  plan: { caseIndex: number; replies: readonly string[] };
  currentCase: RelationshipCase;
  index: number;
}): Promise<QualityGame> {
  const playerId = `multiturn-quality-${runId}-${input.index + 1}`;
  const gameId = playerId;
  const rawLogFile = deepSeekGameLogFile(gameId, input.currentCase.id);
  const game: QualityGame = {
    player_id: playerId,
    session_id: null,
    case_id: input.currentCase.id,
    scene: input.currentCase.real_relationship_scene,
    raw_log_file: rawLogFile,
    completed: false,
    stop_reason: null,
    error: null,
    turns: [],
  };
  const session = await postJson<{ session: { id: string } }>(`${input.baseUrl}/api/session`, {
    visitorId: playerId,
    consentForDataset: true,
  });
  game.session_id = session.body.session.id;

  let turns: ChatTurn[] = [];
  let gameState: SimulationResult["game"] | undefined;
  let previousRecommended: string | null = null;
  let stopSuggested = false;

  for (const [replyIndex, userReply] of input.plan.replies.entries()) {
    const response = await postJson<SimulationResult>(`${input.baseUrl}/api/simulate`, {
      sessionId: game.session_id,
      gameId,
      caseId: input.currentCase.id,
      turns,
      userReply,
      consentForDataset: true,
      mode: "chat",
      gameState,
    });
    if (response.status !== 200 || response.body.error) {
      game.error = String(response.body.message ?? response.body.error ?? `HTTP ${response.status}`);
      break;
    }
    const result = response.body;
    const recommended = result.recommended_reply_80 ?? result.recommended_reply ?? null;
    const qualityTurn: QualityTurn = {
      turn: replyIndex + 1,
      user_reply: userReply,
      previous_recommended_reply_80: previousRecommended,
      matched_previous_recommendation: normalize(userReply) === normalize(previousRecommended),
      target_reply: result.target_reply ?? null,
      recommended_reply_80: recommended,
      perfect_reply_100: result.perfect_reply_100 ?? null,
      next_suggestion: result.next_suggestion ?? null,
      judge: result.judge,
      game: result.game ?? null,
      after_stop_suggestion: stopSuggested,
    };
    game.turns.push(qualityTurn);
    gameState = result.game;
    turns = [
      ...turns,
      { role: "user", text: userReply },
      ...(result.target_reply ? [{ role: "target" as const, text: result.target_reply }] : []),
      ...(result.best_strategy ? [{ role: "advisor" as const, text: result.best_strategy }] : []),
      ...(recommended ? [{ role: "copywriter" as const, text: recommended }] : []),
    ];
    previousRecommended = recommended;
    stopSuggested = hasStopSuggestion(result.next_suggestion);
    if (gameState?.is_complete || stopSuggested) {
      game.completed = Boolean(gameState?.is_complete);
      game.stop_reason = gameState?.completion_reason ?? (stopSuggested ? "deepseek_stop_suggestion" : null);
      break;
    }
  }

  return game;
}

function summarize(games: QualityGame[], dbFile: string, port: number) {
  const allTurns = games.flatMap((game) => game.turns);
  const matchedRecommendation = allTurns.filter((turn) => turn.matched_previous_recommendation);
  const afterStop = allTurns.filter((turn) => turn.after_stop_suggestion);
  const duplicateUser = consecutiveDuplicates(games, (turn) => turn.user_reply);
  const duplicateTarget = consecutiveDuplicates(games, (turn) => turn.target_reply);
  const duplicateRecommended = consecutiveDuplicates(games, (turn) => turn.recommended_reply_80);
  const recommendedEqualsPerfect = allTurns.filter(
    (turn) => normalize(turn.recommended_reply_80) && normalize(turn.recommended_reply_80) === normalize(turn.perfect_reply_100),
  );
  const judgeContradictions = allTurns.filter(hasJudgeContradiction);
  const errors = games.filter((game) => game.error);
  const pass =
    deepSeekEndpointMode(deepSeekBaseUrl) === "live_deepseek_official" &&
    games.length >= 8 &&
    allTurns.length >= 16 &&
    errors.length === 0 &&
    matchedRecommendation.length === 0 &&
    afterStop.length === 0 &&
    duplicateUser.length === 0 &&
    duplicateTarget.length === 0 &&
    duplicateRecommended.length === 0 &&
    recommendedEqualsPerfect.length === 0 &&
    judgeContradictions.length === 0;

  return {
    generated_at: new Date().toISOString(),
    run_id: runId,
    mode: deepSeekEndpointMode(deepSeekBaseUrl),
    deepseek_base_url: deepSeekBaseUrl,
    server_port: port,
    db_file: dbFile,
    game_count: games.length,
    turn_count: allTurns.length,
    error_count: errors.length,
    matched_previous_recommendation_count: matchedRecommendation.length,
    after_stop_suggestion_count: afterStop.length,
    duplicate_user_reply_count: duplicateUser.length,
    duplicate_target_reply_count: duplicateTarget.length,
    duplicate_recommended_reply_count: duplicateRecommended.length,
    recommended_equals_perfect_count: recommendedEqualsPerfect.length,
    judge_score_contradiction_count: judgeContradictions.length,
    raw_log_files: games.map((game) => game.raw_log_file),
    pass,
  };
}

function consecutiveDuplicates(games: QualityGame[], pick: (turn: QualityTurn) => string | null) {
  const duplicates: Array<{ game: string; turn: number; text: string }> = [];
  for (const game of games) {
    let previous = "";
    for (const turn of game.turns) {
      const current = normalize(pick(turn));
      if (current && current === previous) duplicates.push({ game: game.player_id, turn: turn.turn, text: current });
      previous = current;
    }
  }
  return duplicates;
}

function hasJudgeContradiction(turn: QualityTurn) {
  const judge = turn.judge as
    | undefined
    | {
        boundary_score?: number;
        pressure_score?: number;
        trust_score?: number;
        empathy_score?: number;
        risk_score?: number;
        evidence?: string[];
        verdict?: string;
      };
  if (!judge) return true;
  const clauses = [judge.verdict, ...(judge.evidence ?? [])].flatMap((item) => normalize(item).split(/[，。；、,.;|]/));
  const hasNegativeLanguage = clauses.some((clause) => {
    if (/必须立即停止|需要.*道歉|需.*道歉|风险升高|破坏信任/.test(clause)) return true;
    if (/(没有|无|不|避免)/.test(clause)) return false;
    return (
      /(包含|构成|属于|存在|严重|明显)/.test(clause) &&
      /(严重越界|辱骂|攻击|威胁|强迫|情绪勒索|高压施压|无视.*边界)/.test(clause)
    );
  });
  if (!hasNegativeLanguage) return false;
  return [judge.boundary_score, judge.pressure_score, judge.trust_score, judge.empathy_score, judge.risk_score].some(
    (score) => typeof score === "number" && score > 0,
  );
}

function buildMarkdown(summary: ReturnType<typeof summarize>, games: QualityGame[]) {
  return [
    "# DeepSeek 多轮质量 Live 数据",
    "",
    `- generated_at: ${summary.generated_at}`,
    `- mode: ${summary.mode}`,
    `- deepseek_base_url: ${summary.deepseek_base_url}`,
    `- games: ${summary.game_count}`,
    `- turns: ${summary.turn_count}`,
    `- matched_previous_recommendation: ${summary.matched_previous_recommendation_count}`,
    `- after_stop_suggestion: ${summary.after_stop_suggestion_count}`,
    `- duplicate_user_reply: ${summary.duplicate_user_reply_count}`,
    `- duplicate_target_reply: ${summary.duplicate_target_reply_count}`,
    `- duplicate_recommended_reply: ${summary.duplicate_recommended_reply_count}`,
    `- recommended_equals_perfect: ${summary.recommended_equals_perfect_count}`,
    `- judge_score_contradiction: ${summary.judge_score_contradiction_count}`,
    `- pass: ${summary.pass}`,
    "",
    "| player | case | turns | stop_reason | log |",
    "| --- | --- | ---: | --- | --- |",
    ...games.map((game) => [game.player_id, game.case_id, game.turns.length, game.stop_reason ?? "", game.raw_log_file].join(" | ")),
    "",
  ].join("\n");
}

function readSeedCases() {
  return readFileSync(casesPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RelationshipCase);
}

async function postJson<T>(url: string, body: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

function startServer(port: number, dbFile: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), CHAT_DB_FILE: dbFile };
  delete env.RELATIONSHIP_CHAT_TEST_SCORING_SEQUENCE;
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/relationship-chat-server.ts"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[multiturn-server] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[multiturn-server] ${chunk}`));
  return child;
}

async function waitForServer(port: number) {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/cases`);
      if (response.ok) return;
    } catch {
      // keep waiting
    }
    await sleep(250);
  }
  throw new Error(`relationship-chat server did not start on port ${port}`);
}

async function stopServer(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timeout = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 5_000);
  try {
    await once(child, "exit");
  } finally {
    clearTimeout(timeout);
  }
}

async function getFreePort() {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate a local port"));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

function deepSeekGameLogFile(gameId: string, caseId: string) {
  return join("docs", "deepseek-games", `${safeFilePart(gameId)}__${safeFilePart(caseId)}.md`);
}

function safeFilePart(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "unknown";
}

function hasStopSuggestion(value: unknown) {
  return /无需再发|无需继续|不要再发|对话自然结束|自然结束|停止主动联系|停止联系|不用再继续|不必继续|暂时停止对话|等待对方主动联系/.test(
    normalize(value),
  );
}

function normalize(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function sleep(ms: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function timestampRunId() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
}

function assertOfficialOrAllowedDeepSeekEndpoint(value: string) {
  const mode = deepSeekEndpointMode(value);
  if (mode === "live_deepseek_proxy" && process.env.RELATIONSHIP_CHAT_ALLOW_DEEPSEEK_PROXY !== "1") {
    throw new Error(
      `DEEPSEEK_BASE_URL=${value} is not the official DeepSeek endpoint. Set RELATIONSHIP_CHAT_ALLOW_DEEPSEEK_PROXY=1 to explicitly label a proxy run.`,
    );
  }
}

function deepSeekEndpointMode(value: string) {
  try {
    const url = new URL(value);
    if (url.hostname === "api.deepseek.com") return "live_deepseek_official";
    return "live_deepseek_proxy";
  } catch {
    return "live_deepseek_proxy";
  }
}

const plans = [
  {
    caseIndex: 0,
    replies: [
      "我刚才确实让你白等了，这件事是我没安排好。",
      "我明晚八点前会提前确认时间，如果临时变动也会先告诉你。",
      "你也可以告诉我更舒服的节奏，我按那个来。",
    ],
  },
  {
    caseIndex: 5,
    replies: [
      "我听懂你想慢一点，这不是拒绝我，而是你需要安全感。",
      "我不会追问你现在给答案，我们先把聊天变轻松。",
      "今天先聊到这也可以，我会尊重你的状态。",
    ],
  },
  {
    caseIndex: 14,
    replies: [
      "刚刚那句话是我没接住你的情绪，不是你的问题。",
      "我先不解释太多，先说我会怎么改。",
      "下次遇到类似情况我会先确认你的感受，再说自己的理由。",
    ],
  },
  {
    caseIndex: 21,
    replies: [
      "你说想先做朋友，我会尊重这个边界。",
      "我不会用喜欢你这件事给你压力，也不会要求你补偿我的期待。",
      "我们先按朋友的节奏相处，舒服比推进更重要。",
    ],
  },
  {
    caseIndex: 28,
    replies: [
      "我承认刚才推进太快了，可能让你不舒服。",
      "我先把话题收回来，不再继续聊未来承诺。",
      "我们先把这周见面聊轻松一点，其他慢慢来。",
    ],
  },
  {
    caseIndex: 35,
    replies: [
      "你不回我我有点急，但我知道一直追问只会增加压力。",
      "我先停一下，等你方便的时候再看。",
      "如果你愿意说，我会认真听；不想说也没关系。",
    ],
  },
  {
    caseIndex: 42,
    replies: [
      "我刚才的玩笑越界了，对不起。",
      "你冷下来是合理的，我不该用玩笑掩盖你的不舒服。",
      "我会注意这个边界，不再拿这类事开玩笑。",
    ],
  },
  {
    caseIndex: 49,
    replies: [
      "是我一下说远了，可能把压力给到你了。",
      "我们先不聊见家人这种远的事，把当下相处放舒服。",
      "如果你觉得我又推进太快，可以直接提醒我。",
    ],
  },
] as const;

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
