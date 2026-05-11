import test from "node:test";
import assert from "node:assert/strict";

import { readJsonResponse } from "../web/relationship-chat/api.js";

test("reports a readable message when an API response has an empty body", async () => {
  const response = new Response("", {
    status: 502,
    statusText: "Bad Gateway",
  });

  await assert.rejects(
    () => readJsonResponse(response, "模拟失败"),
    /模拟失败：HTTP 502 Bad Gateway/,
  );
});

test("uses the server message when JSON error payload is available", async () => {
  const response = Response.json(
    {
      message: "DeepSeek 暂时不可用",
    },
    { status: 503 },
  );

  await assert.rejects(
    () => readJsonResponse(response, "模拟失败"),
    /DeepSeek 暂时不可用/,
  );
});

test("returns parsed data for successful JSON responses", async () => {
  const response = Response.json({
    ok: true,
  });

  assert.deepEqual(await readJsonResponse(response, "模拟失败"), { ok: true });
});
