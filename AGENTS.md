# AGENTS.md

Project collaboration rules for Codex and human contributors.

Use this file as the default operating contract for coding agents working in this repository.

## 0. Hard Gate: Relationship Chat Must Use Live DeepSeek

- For relationship-chat gameplay, generated chat data, scoring, demo runs, concurrency checks, browser recordings, and user-visible validation, use the real DeepSeek path by default.
- Do not set `RELATIONSHIP_CHAT_TEST_SCORING_SEQUENCE` for user-facing runs, generated datasets, screenshots, recordings, concurrency demos, or automatic game output unless the user explicitly says to use mock, fixture, deterministic, or offline testing.
- Do not present fixed scoring, mocked model output, deterministic fixtures, replayed responses, or direct function calls as real generated data.
- Before claiming generated game/chat data is real, verify that `DEEPSEEK_API_KEY` is loaded and that `/api/simulate` reaches the normal DeepSeek-backed server path.
- If DeepSeek is unavailable, blocked, rate-limited, or too slow, stop and report that live generation is blocked. Do not silently fall back to mock scoring.
- Unit tests may use deterministic scoring fixtures, but final wording must label them as tests/fixtures, not real generated data.
- When the user asks to auto-run multiple games or generate multiple records, choose distinct `case_id` values when possible and report the actual `case_id`, stage, scene, final score, final title, completion reason, and whether the run was live DeepSeek or fixture-backed.
- If multiple runs produce the same title or score, explicitly explain whether that came from live model outputs, the scoring formula, or a fixture. Do not leave repeated titles unexplained.
- For multi-service or concurrent SQLite runs, keep `PRAGMA busy_timeout` enabled and report any lock/retry behavior as part of the validation evidence.

## 0.1 Temporary Hard Gate: Multi-Player Validation

This section applies to the current multi-player validation task unless the user explicitly removes or changes it.

- The validation has two separate tracks: browser players and API virtual players. Do not merge them, substitute one for the other, or claim one track proves the other.
- Browser-player validation means Playwright opens real browser contexts/pages, interacts with the actual UI, fills the visible reply textarea, clicks the visible send button, waits for live DeepSeek-backed UI updates, and reaches visible game completion. Direct HTTP calls do not count as browser-player validation.
- Browser-player validation proves the UI can complete a game; it is not training-quality conversation data when the script fills the visible `recommended_reply_80` / copywriter suggestion back into the textarea.
- Training-quality corpus generation must use the live human-simulator chain: generate each `user_reply` with a separate live DeepSeek human-player simulator, then send that reply through the normal `/api/simulate` server path. Do not reuse the page's `recommended_reply_80`, `perfect_reply_100`, seed recommendation, or previous copywriter output as the next user input.
- For any run described as "像两个人在聊天", "有价值的聊天", corpus, dataset, or training data, require `input_source=live_deepseek_human_simulator`, `corpusTargetTurns=10`, per-turn `actual_user_reply`, `matched_deepseek_recommendation`, quality blocker fields, and a final PASS/FAIL gate.
- For training-quality corpus, the relationship-model response path must be three-layer when available: `responseLayerMode=three_layer`, with separate live DeepSeek calls for Target/Judge, Strategy Advisor, and Copywriter. Final JSON must expose `response_layer_mode=three_layer`, `deepseek_layers.target_judge/advisor/copywriter`, and `layer_outputs.target_judge/advisor/copywriter`; missing layer evidence is a quality blocker.
- If any turn's `actual_user_reply` matches the previous `recommended_reply_80`, previous `perfect_reply_100`, seed recommendation, or a near-duplicate previous user reply, mark that run as a quality blocker. Do not import or present it as good dataset material.
- API virtual-player validation means scripted clients call the real local HTTP API through `/api/session` and `/api/simulate`. Direct imports, direct function calls, replayed JSON, or database inserts do not count.
- Browser validation target: run 5 independent browser players unless DeepSeek or browser runtime fails. Each player must use a distinct session and should use a distinct case when possible.
- API validation target: run 50 to 200 independent virtual players unless DeepSeek rate limits, cost, or runtime failure blocks it. If the exact count is reduced, report the blocker and the actual completed count; do not quietly lower the target.
- Both tracks must use live DeepSeek. `RELATIONSHIP_CHAT_TEST_SCORING_SEQUENCE`, route interception, mocked `/api/simulate`, fixture responses, and deterministic scoring are forbidden for this task.
- Evidence required for completion: output artifact path, run mode, player count, completed game count, request count, failure count, final score/title distribution, duplicate-title explanation, elapsed time, and whether the run used browser UI or API.
- For Playwright evidence, save artifacts under `output/playwright/` and include at least one screenshot or trace/video artifact that shows the real UI after completion.
- For API evidence, save a JSON summary under `output/` containing per-player `session_id`, `case_id`, completion status, final score, final title, and error if any.
- If a service, browser, database, or DeepSeek call fails, diagnose and fix the smallest local issue, then rerun the affected track. Do not label a partial run as complete.

## 0.2 Production Log Investigation Rule

When the user says the server logs, online run, DeepSeek output, score, or relationship-chat behavior feels weird, do not use generic PM2/nginx health as the main evidence. Use PM2/nginx only to prove the service is alive and to locate the right time window. The main target is the latest real DeepSeek input/output and the exact player turn that caused it.

Required production sources to inspect:

- PM2 process metadata for `relationship-chat`: cwd, uptime, restart count, stdout/stderr path, and whether recent restarts may make logs stale.
- Nginx access timestamps for `/chat/api/session`, `/chat/api/cases`, and especially `/chat/api/simulate`, grouped by client/user-agent when possible.
- DeepSeek raw logs under `/home/ubuntu/apps/chat/docs/deepseek-raw-log.md`.
- Per-game DeepSeek logs under `/home/ubuntu/apps/chat/docs/deepseek-games/`, especially the newest file by mtime.
- SQLite state under `/home/ubuntu/apps/chat/.cache/relationship-chat.sqlite` when available through Node `node:sqlite`; do not require the `sqlite3` CLI.

Required DeepSeek fields to extract and report:

- Timestamp in Asia/Shanghai and UTC.
- `mode`, `caseId`, session/player identifier if visible, and HTTP status.
- Full current `scene`, `fixed_labels`, `known_bad_reply`, `seed_best_strategy`, and `seed_recommended_reply`.
- The latest `user_reply` plus enough `previous_turns` tail to understand whether it was human-entered, copied from `recommended_reply_80`, or auto-fed by the UI.
- The exact DeepSeek request contract: system prompt rules, `temperature`, `max_tokens`, and `response_format`.
- The exact DeepSeek output fields: `target_reply`, `best_strategy`, `recommended_reply_80`, `perfect_reply_100`, `judge`, `next_suggestion`, model name, and token usage.

Things agents must explicitly check for:

- Repeated `/chat/api/simulate` calls within a few seconds with the previous `recommended_reply_80` becoming the next `user_reply`.
- A conversation that should have ended, but still sends another turn after `next_suggestion` says to wait, stop, or end naturally.
- Judge score/content mismatch: evidence says pressure, boundary violation, apology needed, or risk increased while scores are positive.
- Model judging the simulated `target_reply` or advisor/copywriter output instead of judging the actual `user_reply`.
- Duplicate or near-duplicate `target_reply`, `recommended_reply_80`, or `perfect_reply_100` loops.
- Score/title oddities caused by app scoring logic versus raw DeepSeek judge output; separate these two sources in the report.
- Live DeepSeek evidence versus fixture/test evidence; never mix them in the final conclusion.

Expected report shape:

- First say whether the service is alive and whether recent restarts may affect evidence.
- Then quote or summarize the latest DeepSeek input/output that matters, not random older logs.
- Then state the weird point as a concrete turn-level finding, for example: "the app sent the suggested reply back as the next user reply after the conversation was already ending."
- If the evidence is insufficient, say exactly which source is missing instead of guessing.

## 0.3 User Data Review Surface

When the user asks to inspect, compare, validate, or review generated data, DeepSeek logs, gameplay runs, scoring results, browser/API validation, or report artifacts, finish by opening the most relevant review surface when technically possible.

Review surface priority:

1. Latest purpose-built HTML dashboard under `output/`, especially `*report.html`, `*viewer.html`, or scenario review pages.
2. Relationship-chat browser UI under `web/relationship-chat/` or the active local server URL when the task is about live gameplay or user-facing behavior.
3. Screenshot, video, or trace artifacts under `output/playwright/` when the task is visual/browser validation.
4. Raw JSON, markdown logs, SQLite extracts, or terminal summaries only as supporting evidence, not the primary thing handed to the user for review.

Do not finish data-review work by only listing raw JSON/log paths if a useful HTML/browser review surface exists or can be produced with a small local adapter. The final handoff must include the opened URL or absolute local artifact path. If the current runtime cannot open the page, state that blocker and still provide the exact path or URL.

## 1. Project Context

- Project name: Relationship chat simulator / relationship strategist data playground
- Goal: Let users play relationship-chat scenarios, score replies through DeepSeek, and store consented chat/game data as future reply-training raw material.
- Primary stack: TypeScript, Node.js, static web UI, SQLite storage, DeepSeek chat completions
- Package manager: npm
- Main app entrypoints:
  - `scripts/relationship-chat-server.ts`
  - `web/relationship-chat/index.html`
- Important directories:
  - `scripts/` - server, scoring, storage, generation, and tests
  - `web/relationship-chat/` - browser UI
  - `data/` - local relationship cases and title catalog
  - `docs/` - specs and DeepSeek logs
  - `output/` - generated validation artifacts

## 2. Commands

Agents should prefer these commands and avoid inventing alternatives unless the project changes.

- Install: `npm install`
- Dev: `npm run dev:web`
- Build: no build step for the current static web/server workflow
- Test: `npm test`
- Lint: no lint command is currently configured
- Typecheck: `npm run typecheck`

## 2.1 Skill Source Resolution

- Resolve same-name skills deterministically: explicit plugin-prefixed names win; otherwise prefer project `.codex/skills`, then user `~/.codex/skills`, then system `.system`, then plugin cache copies.
- When skill source ambiguity matters, run `omx list --sources` and mention the chosen source once instead of asking for confirmation.

## 3. Karpathy-Style Working Principles

### Think Before Coding

- Do not silently guess when requirements are ambiguous.
- State assumptions explicitly before implementation when they affect behavior.
- If multiple interpretations exist, surface them instead of choosing one invisibly.
- If a simpler approach exists, propose it.

### Simplicity First

- Prefer the minimum code that solves the requested problem.
- Do not add speculative abstractions, future-proofing layers, or unused configuration.
- Avoid rewriting 200 lines if 50 lines can solve the task clearly.

### Surgical Changes

- Touch only the files and lines required by the task.
- Do not refactor unrelated code unless explicitly asked.
- Match existing local style before introducing a new pattern.
- Remove only the dead code created by your own change.

### Goal-Driven Execution

- Translate vague tasks into verifiable goals.
- Prefer tests, reproducible checks, or visible success criteria over intuition.
- For multi-step work, state the plan in short steps with verification after each step.

## 4. Git Rules

### Branching

- Do not work directly on `main` for non-trivial changes.
- Prefer a short-lived feature branch:
  - `feature/<topic>`
  - `fix/<topic>`
  - `refactor/<topic>`
  - `docs/<topic>`

### Commits

- Keep commits focused and intentionally scoped.
- Prefer small, reviewable commits over one giant commit.
- Suggested commit style:
  - `feat: add [capability]`
  - `fix: correct [bug]`
  - `refactor: simplify [area]`
  - `docs: update [topic]`
  - `test: cover [behavior]`

### Before Commit

- Run the narrowest verification that proves the change is correct.
- If tests are relevant, run them before claiming completion.
- If verification cannot be run, state that clearly in the final handoff.

## 5. Coding Rules

- Prefer readability over cleverness.
- Follow existing file and naming conventions.
- Reuse established patterns before introducing a new abstraction.
- Keep functions and components focused on one responsibility.
- Do not change comments, formatting, or neighboring code without a task-driven reason.

## 6. Testing Rules

- For bug fixes, prefer writing a test that reproduces the bug before fixing it.
- For new features, prefer behavior-first tests where practical.
- If no automated test is possible, define a manual verification path.
- Every meaningful change should end with explicit verification notes.

## 7. Documentation Rules

- Update docs when behavior, setup, commands, or developer workflow changes.
- Keep documentation aligned with real commands and paths in the repo.
- Prefer concise examples over long explanations.

## 7.1 Video Verification Rules

- When recording a validation video, explicitly label the verification mode in the handoff: deterministic regression, mocked API, fixed-model fixture, or live external-service validation.
- Do not present a mocked, routed, fixture-backed, or deterministic browser recording as a live DeepSeek validation video.
- For live DeepSeek validation, the recording must exercise the real browser UI, real HTTP `/api/simulate`, real DeepSeek request/response, server-side scoring, and final HUD rendering. Do not route/intercept `/api/simulate` and do not set `RELATIONSHIP_CHAT_TEST_SCORING_SEQUENCE`.
- Live validation summaries must include elapsed time, final HUD values, per-turn HTTP status or wait evidence, screenshot path, and video path.
- If a user expects live DeepSeek validation, treat a video shorter than 60 seconds as suspicious unless the summary clearly explains why the real model returned unusually fast. Prefer re-running a longer multi-turn or full-game recording.
- Save validation artifacts under `output/playwright/` with names that distinguish live recordings from deterministic regression recordings.

## 8. Boundaries and Safety

- Never commit secrets, tokens, `.env` contents, or production credentials.
- Do not add dependencies unless they are clearly justified.
- Ask before making destructive data migrations or large directory reshuffles.
- Ask before changing authentication, billing, or production deployment logic unless explicitly requested.

## 9. Agent Workflow

When starting a non-trivial task, agents should usually follow this order:

1. Understand the task and restate assumptions
2. Read the relevant files before editing
3. Identify the smallest safe implementation path
4. Implement in focused changes
5. Verify with tests, builds, or manual checks
6. Report what changed, what was verified, and any remaining risk

## 10. Task Templates

### New Feature

1. Clarify expected behavior
2. Locate similar existing pattern
3. Add or update tests
4. Implement minimal behavior
5. Verify end-to-end path

### Bug Fix

1. Reproduce the issue
2. Identify root cause
3. Add a regression check if practical
4. Fix the smallest correct surface
5. Re-run verification

### Refactor

1. Define the intended improvement
2. Protect behavior with tests or before/after verification
3. Make one focused structural change at a time
4. Confirm behavior is unchanged

## 11. Replace-Me Checklist

Before using this template in a real project, replace:

- project name
- stack
- package manager
- commands
- entrypoints
- directory-specific notes
- any team-specific constraints
