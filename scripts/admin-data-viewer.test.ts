import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("admin data viewer can load same-directory JSON without an admin token", () => {
  const html = readFileSync("web/relationship-chat/admin-data-viewer.html", "utf8");

  assert.match(html, /loadStaticJsonPath/);
  assert.match(html, /canLoadDirectJson/);
  assert.match(html, /fetch\(path,/);
});
