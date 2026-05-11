# Relationship Chat Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the relationship chat page into a multi-user data collection app with anonymous sessions, consent-aware storage, and JSONL export.

**Architecture:** Keep the current single Node server. Add a focused SQLite storage module used by `relationship-chat-server.ts`, then update the browser app to create a session and send consent/session metadata with each simulation request.

**Tech Stack:** Node HTTP server, TypeScript, `node:sqlite`, browser JavaScript, Node built-in test runner.

---

### Task 1: Storage Module

**Files:**
- Create: `scripts/relationship-chat-storage.ts`
- Test: `scripts/relationship-chat-storage.test.ts`

- [ ] Write tests for session creation, simulation recording, consent filtering, and PII masking.
- [ ] Implement SQLite schema and export helpers.
- [ ] Run `node --import tsx --test scripts/relationship-chat-storage.test.ts`.

### Task 2: API Integration

**Files:**
- Modify: `scripts/relationship-chat-server.ts`

- [ ] Add `POST /api/session`.
- [ ] Record `/api/simulate` requests and model responses.
- [ ] Add protected `GET /api/export.jsonl` and `GET /api/stats`.
- [ ] Run typecheck and API smoke checks.

### Task 3: Frontend Consent Flow

**Files:**
- Modify: `web/relationship-chat/index.html`
- Modify: `web/relationship-chat/app.js`
- Modify: `web/relationship-chat/styles.css`

- [ ] Add a plain consent control visible in the chat UI.
- [ ] Create/reuse anonymous visitor and session IDs.
- [ ] Include session ID and consent on simulation calls.
- [ ] Smoke test the page locally.
