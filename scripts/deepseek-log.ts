import { access, mkdir, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type DeepSeekRawLogEntry = {
  timestamp?: string;
  mode: string;
  caseId: string;
  statusCode: number;
  request: unknown;
  rawResponse: unknown;
  rawContent?: string;
};

export const defaultDeepSeekRawLogFile = join(process.cwd(), "docs", "deepseek-raw-log.md");
const defaultDeepSeekLogTimezone = "Asia/Shanghai";

export async function appendDeepSeekRawLog(
  entry: DeepSeekRawLogEntry,
  file = process.env.DEEPSEEK_RAW_LOG_FILE ?? defaultDeepSeekRawLogFile,
) {
  await mkdir(dirname(file), { recursive: true });
  const needsHeader = !(await fileExists(file));
  const timestamp = entry.timestamp ?? formatLocalTimestamp(new Date());
  const section = [
    needsHeader ? fileHeader() : "",
    `## ${timestamp}`,
    "",
    `- mode: ${entry.mode}`,
    `- caseId: ${entry.caseId}`,
    `- statusCode: ${entry.statusCode}`,
    "",
    "### Request body sent to DeepSeek",
    "",
    "```json",
    stableJson(entry.request),
    "```",
    "",
    "### Raw response from DeepSeek",
    "",
    "```json",
    stableJson(entry.rawResponse),
    "```",
    "",
    entry.rawContent
      ? ["### Raw message content", "", "```json", entry.rawContent, "```", ""].join("\n")
      : "",
    "---",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");

  await appendFile(file, `${section}\n`, "utf8");
}

async function fileExists(file: string) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function fileHeader() {
  return [
    "# DeepSeek 原始请求与返回日志",
    "",
    "> 自动追加。记录发给 DeepSeek 的 request body 和 DeepSeek 原始返回；不会记录鉴权密钥。",
    "",
  ].join("\n");
}

function stableJson(value: unknown) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export function formatLocalTimestamp(date: Date, timeZone = process.env.DEEPSEEK_LOG_TIMEZONE ?? defaultDeepSeekLogTimezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}:${pick("second")}.${milliseconds} ${timeZone} (UTC ${date.toISOString()})`;
}
