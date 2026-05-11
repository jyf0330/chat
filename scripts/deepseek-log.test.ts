import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { appendDeepSeekRawLog, formatLocalTimestamp } from "./deepseek-log.ts";

test("formats generated DeepSeek timestamps in local time", () => {
  assert.equal(
    formatLocalTimestamp(new Date("2026-05-11T07:07:51.660Z")),
    "2026-05-11 15:07:51.660 Asia/Shanghai (UTC 2026-05-11T07:07:51.660Z)",
  );
});

test("writes DeepSeek request and raw response without secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deepseek-log-"));
  const file = join(dir, "deepseek-raw-log.md");
  try {
    await appendDeepSeekRawLog(
      {
        timestamp: "2026-05-11T00:00:00.000Z",
        mode: "chat",
        caseId: "case-a",
        statusCode: 200,
        request: {
          model: "deepseek-chat",
          messages: [{ role: "user", content: "hello" }],
          temperature: 0.8,
        },
        rawResponse: {
          choices: [{ message: { content: "{\"target_reply\":\"hi\"}" } }],
        },
        rawContent: "{\"target_reply\":\"hi\"}",
      },
      file,
    );
    await appendDeepSeekRawLog(
      {
        timestamp: "2026-05-11T00:01:00.000Z",
        mode: "chat",
        caseId: "case-b",
        statusCode: 500,
        request: { model: "deepseek-chat", messages: [] },
        rawResponse: "server error",
      },
      file,
    );

    const content = readFileSync(file, "utf8");
    assert.match(content, /DeepSeek 原始请求与返回日志/);
    assert.match(content, /case-a/);
    assert.match(content, /case-b/);
    assert.match(content, /"messages"/);
    assert.match(content, /"target_reply"/);
    assert.equal(content.match(/DeepSeek 原始请求与返回日志/g)?.length, 1);
    assert.equal(content.match(/^## /gm)?.length, 2);
    assert.doesNotMatch(content, /---##/);
    assert.doesNotMatch(content, /authorization/i);
    assert.doesNotMatch(content, /api[_-]?key/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
