import { readFileSync, writeFileSync } from "node:fs";

type CoverageFile = {
  summary: {
    mode: string;
    deepseek_base_url?: string;
    title_catalog_count: number;
    targeted_catalog_prompt_count?: number;
    targeted_title_coverage_count?: number;
    actual_game_title_coverage_count?: number;
    actual_game_title_coverage_pass?: boolean;
    actual_game_title_coverage_note?: string;
    distinct_scene_count: number;
    live_deepseek_turn_count: number;
    quality_failure_count: number;
    error_count: number;
    pass: boolean;
  };
  entries: CoverageEntry[];
};

type CoverageEntry = {
  catalog_title: {
    id: string;
    title: string;
    tone: "positive" | "negative";
  };
  deepseek_input: {
    scene: string;
    previous_turns: Array<{ role: string; text: string }>;
    user_reply: string;
  };
  deepseek_output: {
    target_reply?: string;
    recommended_reply_80?: string;
    perfect_reply_100?: string;
    judge?: {
      boundary_score?: number;
      pressure_score?: number;
      trust_score?: number;
      empathy_score?: number;
      relevance_score?: number;
      risk_score?: number;
      evidence?: string[];
      verdict?: string;
    };
    next_suggestion?: string;
  };
  game: {
    title?: string;
    score?: number;
    is_complete?: boolean;
    completion_reason?: string | null;
  } | null;
  raw_score: number | null;
  status_code: number;
  quality: { pass: boolean; warnings: string[] };
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

const inputPath = process.argv[2] ?? "output/deepseek-title-coverage-live.json";
const outputJsonPath = "output/deepseek-title-coverage-audit.json";
const outputMarkdownPath = "output/deepseek-title-coverage-audit.md";

const data = JSON.parse(readFileSync(inputPath, "utf8")) as CoverageFile;
const audit = buildAudit(data);

writeFileSync(outputJsonPath, JSON.stringify(audit, null, 2), "utf8");
writeFileSync(outputMarkdownPath, buildMarkdown(audit), "utf8");
console.log(`Wrote ${outputJsonPath}`);
console.log(`Wrote ${outputMarkdownPath}`);
console.log(JSON.stringify(audit.summary, null, 2));
if (!audit.summary.pass) process.exitCode = 1;

function buildAudit(data: CoverageFile) {
  const entries = data.entries;
  const distinctScenes = new Set(entries.map((entry) => entry.deepseek_input.scene));
  const targetTitles = new Set(entries.map((entry) => entry.catalog_title.id));
  const rawLogsMissing = entries.filter((entry) => !entry.raw_log_file || !entry.deepseek_request_contract || !entry.raw_response_meta);
  const notLive = entries.filter((entry) => entry.status_code !== 200 || entry.error || !entry.raw_response_meta?.model);
  const matchedPreviousRecommendation = entries.filter((entry) =>
    entry.deepseek_input.previous_turns.some(
      (turn) => turn.role === "copywriter" && normalize(turn.text) === normalize(entry.deepseek_input.user_reply),
    ),
  );
  const hasPreviousTurns = entries.filter((entry) => entry.deepseek_input.previous_turns.length > 0);
  const afterStopSuggestion = entries.filter((entry) => hasStopSuggestion(entry.deepseek_output.next_suggestion) && hasNextTurn(entry));
  const duplicateTarget = consecutiveDuplicates(entries, "target", (entry) => entry.deepseek_output.target_reply);
  const duplicateRecommended = consecutiveDuplicates(entries, "copywriter", (entry) => entry.deepseek_output.recommended_reply_80);
  const duplicateUser = consecutiveDuplicates(entries, "user", (entry) => entry.deepseek_input.user_reply);
  const recommendedEqualsPerfect = entries.filter(
    (entry) => normalize(entry.deepseek_output.recommended_reply_80) === normalize(entry.deepseek_output.perfect_reply_100),
  );
  const judgeContradictions = entries.filter(hasJudgeContradiction);
  const toneMismatch = entries.filter(
    (entry) =>
      entry.raw_score === null ||
      (entry.catalog_title.tone === "positive" && entry.raw_score <= 0) ||
      (entry.catalog_title.tone === "negative" && entry.raw_score >= 0),
  );

  const pass =
    data.summary.mode === "live_deepseek_official" &&
    data.summary.pass === true &&
    targetTitles.size === data.summary.title_catalog_count &&
    distinctScenes.size > 50 &&
    notLive.length === 0 &&
    rawLogsMissing.length === 0 &&
    matchedPreviousRecommendation.length === 0 &&
    afterStopSuggestion.length === 0 &&
    duplicateTarget.length === 0 &&
    duplicateRecommended.length === 0 &&
    recommendedEqualsPerfect.length === 0 &&
    judgeContradictions.length === 0 &&
    toneMismatch.length === 0 &&
    data.summary.quality_failure_count === 0 &&
    data.summary.error_count === 0;

  return {
    generated_at: new Date().toISOString(),
    source_file: inputPath,
    output_files: {
      json: outputJsonPath,
      markdown: outputMarkdownPath,
    },
    summary: {
      mode: data.summary.mode,
      deepseek_base_url: data.summary.deepseek_base_url ?? null,
      target_title_count: data.summary.title_catalog_count,
      targeted_catalog_prompt_count: data.summary.targeted_catalog_prompt_count ?? data.summary.targeted_title_coverage_count ?? targetTitles.size,
      actual_game_title_coverage_count: data.summary.actual_game_title_coverage_count ?? null,
      actual_game_title_coverage_pass: data.summary.actual_game_title_coverage_pass ?? false,
      actual_game_title_coverage_note: data.summary.actual_game_title_coverage_note ?? null,
      distinct_scene_count: distinctScenes.size,
      live_deepseek_turn_count: data.summary.live_deepseek_turn_count,
      raw_logs_missing_count: rawLogsMissing.length,
      not_live_count: notLive.length,
      previous_turn_entry_count: hasPreviousTurns.length,
      matched_previous_recommendation_count: matchedPreviousRecommendation.length,
      after_stop_suggestion_count: afterStopSuggestion.length,
      duplicate_user_reply_count: duplicateUser.length,
      duplicate_target_reply_count: duplicateTarget.length,
      duplicate_recommended_reply_count: duplicateRecommended.length,
      recommended_equals_perfect_count: recommendedEqualsPerfect.length,
      judge_score_contradiction_count: judgeContradictions.length,
      tone_mismatch_count: toneMismatch.length,
      quality_failure_count: data.summary.quality_failure_count,
      error_count: data.summary.error_count,
      pass,
    },
    failures: {
      raw_logs_missing: rawLogsMissing.map(entryLabel),
      not_live: notLive.map(entryLabel),
      matched_previous_recommendation: matchedPreviousRecommendation.map(entryLabel),
      after_stop_suggestion: afterStopSuggestion.map(entryLabel),
      duplicate_user_reply: duplicateUser.map((item) => duplicateLabel(item)),
      duplicate_target_reply: duplicateTarget.map((item) => duplicateLabel(item)),
      duplicate_recommended_reply: duplicateRecommended.map((item) => duplicateLabel(item)),
      judge_score_contradictions: judgeContradictions.map(entryLabel),
      tone_mismatch: toneMismatch.map(entryLabel),
    },
  };
}

function hasNextTurn(_entry: CoverageEntry) {
  return false;
}

function hasStopSuggestion(value: unknown) {
  const text = normalize(value);
  return /无需再发|无需继续|不要再发|对话自然结束|自然结束|停止主动联系|停止联系|不用再继续|不必继续|暂时停止对话|等待对方主动联系/.test(text);
}

function consecutiveDuplicates(entries: CoverageEntry[], role: string, pick: (entry: CoverageEntry) => unknown) {
  const duplicates: Array<{ text: string; first: CoverageEntry; duplicate: CoverageEntry }> = [];
  for (const entry of entries) {
    const current = normalize(pick(entry));
    if (!current) continue;
    const previousSameRole = [...entry.deepseek_input.previous_turns].reverse().find((turn) => turn.role === role);
    if (previousSameRole && normalize(previousSameRole.text) === current) {
      duplicates.push({ text: current, first: entry, duplicate: entry });
    }
  }
  return duplicates;
}

function hasJudgeContradiction(entry: CoverageEntry) {
  const judge = entry.deepseek_output.judge;
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
  const directionalScores = [
    judge.boundary_score,
    judge.pressure_score,
    judge.trust_score,
    judge.empathy_score,
    judge.risk_score,
  ].filter((score): score is number => typeof score === "number");
  return directionalScores.some((score) => score > 0);
}

function buildMarkdown(audit: ReturnType<typeof buildAudit>) {
  const summary = audit.summary;
  return [
    "# DeepSeek 称号覆盖质量审计",
    "",
    `- generated_at: ${audit.generated_at}`,
    `- source_file: ${audit.source_file}`,
    `- mode: ${summary.mode}`,
    `- targeted catalog prompts: ${summary.targeted_catalog_prompt_count}/${summary.target_title_count}`,
    `- actual game title coverage: ${summary.actual_game_title_coverage_count}/${summary.target_title_count}`,
    `- actual game title coverage pass: ${summary.actual_game_title_coverage_pass}`,
    `- actual game title note: ${summary.actual_game_title_coverage_note}`,
    `- distinct scenes: ${summary.distinct_scene_count}`,
    `- live DeepSeek turns: ${summary.live_deepseek_turn_count}`,
    `- matched_previous_recommendation: ${summary.matched_previous_recommendation_count}`,
    `- after_stop_suggestion: ${summary.after_stop_suggestion_count}`,
    `- duplicate_user_reply: ${summary.duplicate_user_reply_count}`,
    `- duplicate_target_reply: ${summary.duplicate_target_reply_count}`,
    `- duplicate_recommended_reply: ${summary.duplicate_recommended_reply_count}`,
    `- recommended_equals_perfect: ${summary.recommended_equals_perfect_count}`,
    `- judge_score_contradiction: ${summary.judge_score_contradiction_count}`,
    `- tone_mismatch: ${summary.tone_mismatch_count}`,
    `- pass: ${summary.pass}`,
    "",
    "## 失败项",
    "",
    ...Object.entries(audit.failures).map(([name, items]) => `- ${name}: ${items.length}`),
    "",
  ].join("\n");
}

function entryLabel(entry: CoverageEntry) {
  return {
    title_id: entry.catalog_title.id,
    title: entry.catalog_title.title,
    tone: entry.catalog_title.tone,
    raw_score: entry.raw_score,
    game_title: entry.game?.title ?? null,
    log: entry.raw_log_file,
  };
}

function duplicateLabel(item: { text: string; first: CoverageEntry; duplicate: CoverageEntry }) {
  return {
    text: item.text,
    first: entryLabel(item.first),
    duplicate: entryLabel(item.duplicate),
  };
}

function normalize(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}
