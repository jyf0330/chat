# Relationship Chat Game Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the relationship chat simulator into a 10-turn scoring game with deterministic -100 to 100 scores, titles, 80-point fillable replies, hidden 100-point reference replies, and history records.

**Architecture:** Keep LLM outputs as judgment material and answer suggestions only; calculate game scores in code. Store game snapshots inside simulation results so history/export can reconstruct final titles without a separate game table.

**Tech Stack:** TypeScript, Node HTTP server, SQLite storage, browser JavaScript, existing DeepSeek chat-completions API.

---

### Task 1: Pure Game Scoring

**Files:**
- Create: `scripts/relationship-chat-game.ts`
- Create: `scripts/relationship-chat-game.test.ts`

- [x] Add normalized judge parsing, score delta calculation, title bands, 10-turn completion, and early end on `blocked` or absolute score caps.
- [x] Verify with `npm test`.

### Task 2: Model Contract

**Files:**
- Modify: `scripts/relationship-chat-storage.ts`
- Modify: `scripts/relationship-chat-server.ts`

- [x] Extend simulation results with `recommended_reply_80`, `perfect_reply_100`, and `game`.
- [x] Keep `recommended_reply` as a compatibility alias for the 80-point reply.
- [x] Add server-side score calculation after each successful chat-mode simulation.

### Task 3: Game UI

**Files:**
- Modify: `web/relationship-chat/index.html`
- Modify: `web/relationship-chat/app.js`
- Modify: `web/relationship-chat/styles.css`

- [x] Show only total score and current risk in the main scoring strip.
- [x] Show only the 80-point reply in the copywriter bubble.
- [x] Insert an end-of-game settlement bubble at turn 10 or early end.
- [x] Add a history screen with final score/title cards.

### Task 4: Verification And Deploy

**Files:**
- No source changes expected.

- [x] Run `npm test`, `npm run typecheck`, and JS syntax checks.
- [x] Smoke test local `/chat/`.
- [x] Sync to `/home/ubuntu/apps/chat`, install dependencies if needed, restart PM2, and verify public `/chat/`.
