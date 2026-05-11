import "dotenv/config";

import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import {
  calculateRawScore,
  normalizeJudge,
  type NormalizedJudge,
} from "./relationship-chat-game.ts";
import type { ChatTurn, RelationshipCase, SimulationResult } from "./relationship-chat-storage.ts";

type TitleCatalogEntry = {
  id: string;
  title: string;
  tone: "positive" | "negative";
  score_min: number;
  score_max: number;
  tags: string[];
};

type TitleCatalog = {
  schema_version: string;
  description?: string;
  titles: TitleCatalogEntry[];
};

type CoverageEntry = {
  catalog_title: TitleCatalogEntry;
  coverage_case: RelationshipCase;
  session_id: string | null;
  visitor_id: string;
  game_id: string;
  status_code: number;
  elapsed_ms: number;
  deepseek_input: {
    scene: string;
    fixed_labels: {
      relationship_stage: string;
      target_emotion: string;
      risk_level: string;
    };
    previous_turns: ChatTurn[];
    user_reply: string;
    mode: "chat";
  };
  deepseek_output: Pick<
    SimulationResult,
    "target_reply" | "best_strategy" | "recommended_reply_80" | "perfect_reply_100" | "judge" | "next_suggestion"
  >;
  game: SimulationResult["game"] | null;
  raw_score: number | null;
  normalized_judge: NormalizedJudge | null;
  quality: {
    pass: boolean;
    checks: Record<string, boolean>;
    warnings: string[];
  };
  deepseek_request_contract: null | {
    model: string;
    temperature: number;
    max_tokens: number;
    response_format: unknown;
  };
  raw_response_meta: null | {
    id?: string;
    model?: string;
    usage?: unknown;
  };
  raw_log_file: string;
  error: string | null;
};

const titleCatalogPath = "data/relationship-title-catalog.json";
const casesPath = "data/relationship-cases-deepseek.extracted.jsonl";
const outputJsonPath = "output/deepseek-title-coverage-live.json";
const outputMarkdownPath = "output/deepseek-title-coverage-live.md";
const runId = process.env.RELATIONSHIP_CHAT_COVERAGE_RUN_ID ?? timestampRunId();
const concurrency = clampNumber(Number(process.env.RELATIONSHIP_CHAT_COVERAGE_CONCURRENCY ?? "3"), 1, 8);
const maxRetries = clampNumber(Number(process.env.RELATIONSHIP_CHAT_COVERAGE_RETRIES ?? "1"), 0, 3);
const deepSeekBaseUrl = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";

async function main() {
  if (process.env.RELATIONSHIP_CHAT_TEST_SCORING_SEQUENCE) {
    throw new Error("RELATIONSHIP_CHAT_TEST_SCORING_SEQUENCE is set; live coverage generation refuses fixture scoring.");
  }
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is missing; live DeepSeek coverage cannot run.");
  }
  assertOfficialOrAllowedDeepSeekEndpoint(deepSeekBaseUrl);

  mkdirSync("output", { recursive: true });
  mkdirSync("docs/deepseek-games", { recursive: true });
  mkdirSync(".cache", { recursive: true });

  const catalog = readCatalog();
  const seedCases = readSeedCases();
  const port = await getFreePort();
  const dbFile = resolve(".cache", `relationship-chat-title-coverage-${runId}.sqlite`);
  await rm(dbFile, { force: true });
  await rm(`${dbFile}-shm`, { force: true });
  await rm(`${dbFile}-wal`, { force: true });

  const server = startServer(port, dbFile);
  try {
    await waitForServer(port);
    const entries = await runCoverage({ port, catalog, seedCases });
    const summary = buildSummary({ catalog, entries, dbFile, port });
    writeFileSync(outputJsonPath, JSON.stringify({ summary, entries }, null, 2), "utf8");
    writeFileSync(outputMarkdownPath, buildMarkdown(summary, entries), "utf8");
    console.log(`Wrote ${outputJsonPath}`);
    console.log(`Wrote ${outputMarkdownPath}`);
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.targeted_catalog_data_pass) {
      process.exitCode = 1;
    }
  } finally {
    await stopServer(server);
  }
}

function readCatalog() {
  const catalog = JSON.parse(readFileSync(titleCatalogPath, "utf8")) as TitleCatalog;
  if (!Array.isArray(catalog.titles) || !catalog.titles.length) {
    throw new Error(`${titleCatalogPath} has no titles`);
  }
  return catalog;
}

function readSeedCases() {
  return readFileSync(casesPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RelationshipCase);
}

async function runCoverage(input: { port: number; catalog: TitleCatalog; seedCases: RelationshipCase[] }) {
  const tasks = input.catalog.titles.map((title, index) => async () =>
    runOneTitle({
      baseUrl: `http://127.0.0.1:${input.port}`,
      title,
      seedCase: input.seedCases[index % input.seedCases.length],
      index,
    }),
  );
  return runPool(tasks, concurrency);
}

async function runOneTitle(input: {
  baseUrl: string;
  title: TitleCatalogEntry;
  seedCase: RelationshipCase;
  index: number;
}): Promise<CoverageEntry> {
  const started = Date.now();
  const coverageCase = buildCoverageCase(input.title, input.seedCase, input.index);
  const visitorId = `title-coverage-${runId}-${input.title.id}`;
  const gameId = `title-coverage-${runId}-${input.title.id}`;
  let sessionId: string | null = null;
  let lastError: string | null = null;
  let result: SimulationResult | null = null;
  let statusCode = 0;
  let actualGameId = `${gameId}-0`;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      actualGameId = `${gameId}-${attempt}`;
      const sessionResponse = await postJson<{ session: { id: string } }>(`${input.baseUrl}/api/session`, {
        visitorId: `${visitorId}-${attempt}`,
        consentForDataset: true,
      });
      sessionId = sessionResponse.body.session.id;
      const response = await postJson<SimulationResult>(`${input.baseUrl}/api/simulate`, {
        sessionId,
        gameId: actualGameId,
        caseId: coverageCase.id,
        customCase: coverageCase,
        turns: [],
        userReply: coverageCase.recommended_reply,
        consentForDataset: true,
        mode: "chat",
      });
      statusCode = response.status;
      result = response.body;
      lastError = result.error ? String(result.message ?? result.error) : null;

      const judge = result.judge ? normalizeJudge(result.judge) : null;
      const rawScore = judge ? calculateRawScore(judge) : null;
      if (statusCode === 200 && result.target_reply && qualityFor(input.title, coverageCase, result, rawScore).pass) {
        break;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  const actualRawLogFile = deepSeekGameLogFile(actualGameId, coverageCase.id);
  const parsedLog = await readParsedLog(actualRawLogFile).catch(() => null);
  const judge = result?.judge ? normalizeJudge(result.judge) : null;
  const rawScore = judge ? calculateRawScore(judge) : null;
  return {
    catalog_title: input.title,
    coverage_case: coverageCase,
    session_id: sessionId,
    visitor_id: visitorId,
    game_id: gameId,
    status_code: statusCode,
    elapsed_ms: Date.now() - started,
    deepseek_input: {
      scene: coverageCase.real_relationship_scene,
      fixed_labels: {
        relationship_stage: coverageCase.relationship_stage_label,
        target_emotion: coverageCase.target_emotion_label,
        risk_level: coverageCase.risk_level,
      },
      previous_turns: [],
      user_reply: coverageCase.recommended_reply,
      mode: "chat",
    },
    deepseek_output: {
      target_reply: result?.target_reply,
      best_strategy: result?.best_strategy,
      recommended_reply_80: result?.recommended_reply_80,
      perfect_reply_100: result?.perfect_reply_100,
      judge: result?.judge,
      next_suggestion: result?.next_suggestion,
    },
    game: result?.game ?? null,
    raw_score: rawScore,
    normalized_judge: judge,
    quality: qualityFor(input.title, coverageCase, result, rawScore),
    deepseek_request_contract: parsedLog?.request
      ? {
          model: parsedLog.request.model,
          temperature: parsedLog.request.temperature,
          max_tokens: parsedLog.request.max_tokens,
          response_format: parsedLog.request.response_format,
        }
      : null,
    raw_response_meta: parsedLog?.rawResponse
      ? {
          id: parsedLog.rawResponse.id,
          model: parsedLog.rawResponse.model,
          usage: parsedLog.rawResponse.usage,
        }
      : null,
    raw_log_file: actualRawLogFile,
    error: lastError,
  };
}

function buildCoverageCase(title: TitleCatalogEntry, seedCase: RelationshipCase, index: number): RelationshipCase {
  const tone = title.tone;
  const context = contextVariants[index % contextVariants.length];
  const scene = [
    seedCase.real_relationship_scene,
    `这次的具体细节是：${context}`,
    tone === "positive"
      ? "对方没有明确拒绝，只是在观察你接下来会不会尊重节奏。"
      : "对方已经表现出明显不舒服，需要看你是否继续加压或及时收住。",
  ].join("");

  return {
    ...seedCase,
    id: `coverage_${title.id}`,
    real_relationship_scene: scene,
    relationship_stage_label: seedCase.relationship_stage_label,
    target_emotion_label: tone === "positive" ? seedCase.target_emotion_label : negativeEmotionFor(title),
    risk_level: riskFor(title),
    wrong_reply: badReplyFor(title),
    best_strategy: strategyFor(title),
    recommended_reply: replyFor(title),
    user_feedback: null,
    generator_meta: {
      source: "live_title_coverage",
      run_id: runId,
      target_title_id: title.id,
      target_title: title.title,
      target_tags: title.tags,
    },
  };
}

function replyFor(title: TitleCatalogEntry) {
  if (title.tone === "negative") return badReplyFor(title);
  if (title.tags.includes("safe_exit")) {
    return "我听到了，我先停在这里，不追问也不催你。你舒服的时候再说就好。";
  }
  if (title.tags.includes("repair") || title.tags.includes("comeback")) {
    return "刚刚是我没处理好，让你有压力了。接下来我会把节奏放慢，也会用行动补上。";
  }
  if (title.tags.includes("perfect") || title.tags.includes("high_score")) {
    return "我理解你的感受，也不会逼你现在给答案。我会把这件事记下来，接下来用具体行动让你安心。";
  }
  if (title.tags.includes("pressure_lowered")) {
    return "不用急着回复我，我只是想把态度说明白。你按自己的节奏来，我在。";
  }
  if (title.tags.includes("boundary_respected")) {
    return "我尊重你的边界，也不会继续把话题往前推。我们先把当下聊舒服。";
  }
  if (title.tags.includes("empathy")) {
    return "我能理解你为什么会难受，这件事确实是我没有照顾到你的感受。";
  }
  return "我听懂了，我们慢慢来。我会先照顾你的感受，不急着证明什么。";
}

function badReplyFor(title: TitleCatalogEntry) {
  if (title.tags.includes("blocked") || title.tags.includes("severe_negative")) {
    return "你今天必须给我一个说法，不回我我就一直打电话，必要的话我去你楼下等。";
  }
  if (title.tags.includes("boundary_broken")) {
    return "你别再说什么边界了，我们都聊到这一步了，你现在退就是在耍我。";
  }
  if (title.tags.includes("pressure_added")) {
    return "你现在就回答我，到底要不要继续，不要再用忙来敷衍我。";
  }
  if (title.tags.includes("trust_damaged")) {
    return "你就是不在乎我，之前说的那些好听话现在看来都挺假的。";
  }
  if (title.tags.includes("empathy_low")) {
    return "这有什么好难过的，你是不是想太多了，我已经够累了。";
  }
  if (title.tags.includes("relevant_low")) {
    return "随便吧，我现在不想聊这个，反正你怎么想都行。";
  }
  return "你怎么又这样，我都解释过了，你还要我怎样？";
}

function strategyFor(title: TitleCatalogEntry) {
  if (title.tone === "negative") {
    return "识别越界和加压点，提醒用户停止推进、道歉并把主动权还给对方。";
  }
  if (title.tags.includes("safe_exit")) return "体面收住，不继续索取回应，把空间还给对方。";
  if (title.tags.includes("repair")) return "先承认影响，再给具体修复动作，不用解释压过感受。";
  return "先接住情绪，再降低压力，给出具体但不越界的下一步。";
}

function negativeEmotionFor(title: TitleCatalogEntry) {
  if (title.tags.includes("blocked")) return "防御";
  if (title.tags.includes("pressure_added")) return "紧张";
  if (title.tags.includes("empathy_low")) return "失望";
  return "不适";
}

function riskFor(title: TitleCatalogEntry) {
  if (title.tags.includes("blocked") || title.tags.includes("severe_negative")) return "blocked";
  if (title.tone === "negative") return title.score_max <= -30 ? "high" : "medium";
  if (title.tags.includes("safe_exit")) return "high";
  return "low";
}

function qualityFor(
  title: TitleCatalogEntry,
  coverageCase: RelationshipCase,
  result: SimulationResult | null,
  rawScore: number | null,
) {
  const targetReply = normalizeText(result?.target_reply);
  const recommended = normalizeText(result?.recommended_reply_80 ?? result?.recommended_reply);
  const perfect = normalizeText(result?.perfect_reply_100);
  const userReply = normalizeText(coverageCase.recommended_reply);
  const verdict = normalizeText((result?.judge as { verdict?: unknown } | undefined)?.verdict);
  const checks = {
    live_http_ok: Boolean(result && !result.error),
    has_target_reply: targetReply.length >= 2,
    has_strategy: normalizeText(result?.best_strategy).length >= 4,
    has_recommended_80: recommended.length >= 4,
    has_perfect_100: perfect.length >= 4,
    recommended_80_distinct_from_perfect_100: Boolean(recommended && perfect && recommended !== perfect),
    target_reply_is_chat_like: targetReply.length >= 2 && targetReply.length <= 90 && !/Strategy|Copywriter|用户回复|judge/i.test(targetReply),
    user_reply_not_model_recommendation: userReply !== recommended && userReply !== perfect,
    judge_present: Boolean(result?.judge && verdict),
    tone_score_aligned: scoreAlignsWithTone(title, rawScore),
  };
  const warnings = Object.entries(checks)
    .filter(([, pass]) => !pass)
    .map(([name]) => name);
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    warnings,
  };
}

function scoreAlignsWithTone(title: TitleCatalogEntry, rawScore: number | null) {
  if (rawScore === null) return false;
  return title.tone === "positive" ? rawScore > 0 : rawScore < 0;
}

async function readParsedLog(path: string) {
  const markdown = await readFile(path, "utf8");
  const request = parseJsonBlock(markdown, "### Request body sent to DeepSeek");
  const rawResponse = parseJsonBlock(markdown, "### Raw response from DeepSeek");
  return { request, rawResponse };
}

function parseJsonBlock(markdown: string, heading: string) {
  const start = markdown.indexOf(heading);
  if (start === -1) return null;
  const rest = markdown.slice(start);
  const match = rest.match(/```json\n([\s\S]*?)\n```/);
  if (!match) return null;
  return JSON.parse(match[1]);
}

function buildSummary(input: {
  catalog: TitleCatalog;
  entries: CoverageEntry[];
  dbFile: string;
  port: number;
}) {
  const distinctScenes = new Set(input.entries.map((entry) => entry.deepseek_input.scene));
  const coveredTitleIds = new Set(input.entries.filter((entry) => entry.status_code === 200).map((entry) => entry.catalog_title.id));
  const actualGameTitles = new Set(input.entries.map((entry) => entry.game?.title).filter(Boolean));
  const qualityFailures = input.entries.filter((entry) => !entry.quality.pass);
  const errors = input.entries.filter((entry) => entry.error);
  const targetedCatalogDataPass =
    coveredTitleIds.size === input.catalog.titles.length &&
    distinctScenes.size > 50 &&
    errors.length === 0 &&
    qualityFailures.length === 0;
  const actualGameTitleCoveragePass = actualGameTitles.size === input.catalog.titles.length;
  return {
    generated_at: new Date().toISOString(),
    run_id: runId,
    mode: deepSeekEndpointMode(deepSeekBaseUrl),
    deepseek_base_url: deepSeekBaseUrl,
    server_port: input.port,
    db_file: input.dbFile,
    source_files: {
      title_catalog: titleCatalogPath,
      seed_cases: casesPath,
    },
    output_files: {
      json: outputJsonPath,
      markdown: outputMarkdownPath,
    },
    title_catalog_count: input.catalog.titles.length,
    targeted_catalog_prompt_count: coveredTitleIds.size,
    targeted_catalog_prompt_pass: coveredTitleIds.size === input.catalog.titles.length,
    distinct_scene_count: distinctScenes.size,
    distinct_scene_pass: distinctScenes.size > 50,
    live_deepseek_turn_count: input.entries.filter((entry) => entry.status_code === 200).length,
    actual_game_title_coverage_count: actualGameTitles.size,
    actual_game_title_coverage_pass: actualGameTitleCoveragePass,
    actual_game_title_coverage_note:
      "This single-turn coverage run targets every catalog title as data metadata; it does not claim every title was selected as the actual game settlement title.",
    actual_game_titles: [...actualGameTitles].sort(),
    quality_failure_count: qualityFailures.length,
    quality_failures: qualityFailures.map((entry) => ({
      title_id: entry.catalog_title.id,
      title: entry.catalog_title.title,
      warnings: entry.quality.warnings,
      raw_score: entry.raw_score,
      game_title: entry.game?.title ?? null,
    })),
    error_count: errors.length,
    errors: errors.map((entry) => ({
      title_id: entry.catalog_title.id,
      title: entry.catalog_title.title,
      error: entry.error,
    })),
    targeted_catalog_data_pass: targetedCatalogDataPass,
    pass: targetedCatalogDataPass,
  };
}

function buildMarkdown(summary: ReturnType<typeof buildSummary>, entries: CoverageEntry[]) {
  const lines = [
    "# DeepSeek 称号覆盖 Live 数据",
    "",
    `- generated_at: ${summary.generated_at}`,
    `- run_id: ${summary.run_id}`,
    `- mode: ${summary.mode}`,
    `- deepseek_base_url: ${summary.deepseek_base_url}`,
    `- targeted catalog prompts: ${summary.targeted_catalog_prompt_count}/${summary.title_catalog_count}`,
    `- actual game title coverage: ${summary.actual_game_title_coverage_count}/${summary.title_catalog_count}`,
    `- actual game title note: ${summary.actual_game_title_coverage_note}`,
    `- distinct scenes: ${summary.distinct_scene_count}`,
    `- live DeepSeek turns: ${summary.live_deepseek_turn_count}`,
    `- quality failures: ${summary.quality_failure_count}`,
    `- errors: ${summary.error_count}`,
    `- targeted_catalog_data_pass: ${summary.targeted_catalog_data_pass}`,
    "",
    "| title_id | title | tone | raw_score | game_title | user_reply | target_reply | log |",
    "| --- | --- | --- | ---: | --- | --- | --- | --- |",
    ...entries.map((entry) =>
      [
        entry.catalog_title.id,
        entry.catalog_title.title,
        entry.catalog_title.tone,
        entry.raw_score ?? "",
        entry.game?.title ?? "",
        compactCell(entry.deepseek_input.user_reply),
        compactCell(entry.deepseek_output.target_reply),
        entry.raw_log_file,
      ].join(" | "),
    ),
    "",
  ];
  return lines.join("\n");
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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    CHAT_DB_FILE: dbFile,
    ADMIN_EXPORT_TOKEN: "title-coverage-local",
  };
  delete env.RELATIONSHIP_CHAT_TEST_SCORING_SEQUENCE;
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/relationship-chat-server.ts"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[coverage-server] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[coverage-server] ${chunk}`));
  return child;
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

async function runPool<T>(tasks: Array<() => Promise<T>>, limit: number) {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]();
      console.log(`coverage ${index + 1}/${tasks.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
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

function compactCell(value: unknown) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "/")
    .slice(0, 80);
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function sleep(ms: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

const contextVariants = [
  "你们原本约好十点通话，但对方临时加班，只发来一句“今晚可能不行”。",
  "对方刚经历家庭压力，回复变慢，但仍愿意解释自己的状态。",
  "你之前开了一个玩笑，对方表情明显冷下来，隔了很久才回。",
  "你们聊到是否见面，对方说想再观察一段时间。",
  "对方说最近社交电量很低，希望聊天节奏轻一点。",
  "你发了几条消息都没得到回应，对方后来解释手机没电。",
  "你们刚从争执里缓下来，对方还在确认你是不是真的理解了。",
  "对方提出先做朋友，你心里不舒服但还想保留体面。",
  "你答应过的事情又忘了，对方这次没有吵，只说有点累。",
  "对方说自己不喜欢被追问行程，但愿意在舒服时主动分享。",
];

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
