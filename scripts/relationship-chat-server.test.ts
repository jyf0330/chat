import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import test from "node:test";
import assert from "node:assert/strict";

const publicJsonPath = join(process.cwd(), "web", "relationship-chat", "__static-deny-test.json");
const artifactJsonPath = join(process.cwd(), "output", "__admin-artifact-test.json");

test("server blocks public JSON artifacts and requires bearer admin auth", async () => {
  const port = await getFreePort();
  const dbDir = join(tmpdir(), `relationship-chat-server-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const token = "test-admin-token";
  let child: ChildProcess | null = null;

  mkdirSync(join(process.cwd(), "output"), { recursive: true });
  mkdirSync(dbDir, { recursive: true });
  writeFileSync(publicJsonPath, JSON.stringify({ leaked: true }), "utf8");
  writeFileSync(artifactJsonPath, JSON.stringify({ ok: true }), "utf8");

  try {
    child = spawn(process.execPath, ["--import", "tsx", "scripts/relationship-chat-server.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        CHAT_DB_FILE: join(dbDir, "chat.sqlite"),
        ADMIN_EXPORT_TOKEN: token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForServer(port, child);

    const publicJson = await fetch(`http://127.0.0.1:${port}/__static-deny-test.json`);
    assert.equal(publicJson.status, 404);

    const queryToken = await fetch(
      `http://127.0.0.1:${port}/api/admin-artifact?path=${encodeURIComponent("output/__admin-artifact-test.json")}&token=${token}`,
    );
    assert.equal(queryToken.status, 401);

    const bearer = await fetch(
      `http://127.0.0.1:${port}/api/admin-artifact?path=${encodeURIComponent("output/__admin-artifact-test.json")}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(bearer.status, 200);
    assert.deepEqual(await bearer.json(), { ok: true });
  } finally {
    child?.kill();
    rmSync(publicJsonPath, { force: true });
    rmSync(artifactJsonPath, { force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});

function getFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("No port address"));
      });
    });
  });
}

async function waitForServer(port: number, child: ChildProcess) {
  const deadline = Date.now() + 8000;
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with ${child.exitCode}: ${stderr}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/cases`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Server did not start: ${stderr}`);
}
