import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GameState } from "./relationship-chat-game.ts";

export type ChatTurn = {
  role: "user" | "target" | "advisor" | "copywriter";
  text: string;
};

export type RelationshipCase = {
  id: string;
  real_relationship_scene: string;
  relationship_stage_label: string;
  target_emotion_label: string;
  risk_level: string;
  wrong_reply: string;
  best_strategy: string;
  recommended_reply: string;
  user_feedback: null | string;
  generator_meta?: Record<string, unknown>;
};

export type SimulationMode = "chat" | "prime";

export type SimulationResult = {
  target_reply?: string;
  best_strategy?: string;
  recommended_reply?: string;
  recommended_reply_80?: string;
  perfect_reply_100?: string;
  judge?: unknown;
  game?: GameState;
  next_suggestion?: string;
  raw?: string;
  [key: string]: unknown;
};

export type StoredSession = {
  id: string;
  visitorId: string;
  consentForDataset: boolean;
  createdAt: string;
};

type SessionInput = {
  visitorId?: string;
  consentForDataset: boolean;
  userAgent?: string;
};

type SimulationInput = {
  sessionId: string;
  caseId: string;
  mode: SimulationMode;
  consentForDataset: boolean;
  customCase?: RelationshipCase;
  turns: ChatTurn[];
  userReply: string;
  result: SimulationResult;
};

type CountRow = {
  count: number;
};

const defaultDbFile = join(process.cwd(), ".cache", "relationship-chat.sqlite");

export class RelationshipChatStore {
  private readonly db: DatabaseSync;

  constructor(dbFile = process.env.CHAT_DB_FILE ?? defaultDbFile) {
    mkdirSync(dirname(dbFile), { recursive: true });
    this.db = new DatabaseSync(dbFile);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close() {
    this.db.close();
  }

  createSession(input: SessionInput): StoredSession {
    const id = randomUUID();
    const visitorId = input.visitorId?.trim() || randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        [
          "INSERT INTO sessions (id, visitor_id, consent_for_dataset, user_agent, created_at, updated_at)",
          "VALUES (?, ?, ?, ?, ?, ?)",
        ].join(" "),
      )
      .run(id, visitorId, input.consentForDataset ? 1 : 0, input.userAgent ?? null, createdAt, createdAt);

    return {
      id,
      visitorId,
      consentForDataset: input.consentForDataset,
      createdAt,
    };
  }

  recordSimulation(input: SimulationInput) {
    const now = new Date().toISOString();
    const session = this.db.prepare("SELECT id FROM sessions WHERE id = ?").get(input.sessionId);
    if (!session) {
      throw new Error(`Unknown relationship chat session: ${input.sessionId}`);
    }

    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("UPDATE sessions SET consent_for_dataset = ?, updated_at = ? WHERE id = ?")
        .run(input.consentForDataset ? 1 : 0, now, input.sessionId);

      const simulationId = randomUUID();
      this.db
        .prepare(
          [
            "INSERT INTO simulations",
            "(id, session_id, case_id, mode, consent_for_dataset, custom_case_json, turns_json, user_reply, result_json, created_at)",
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ].join(" "),
        )
        .run(
          simulationId,
          input.sessionId,
          input.caseId,
          input.mode,
          input.consentForDataset ? 1 : 0,
          input.customCase ? JSON.stringify(input.customCase) : null,
          JSON.stringify(input.turns),
          input.userReply,
          JSON.stringify(input.result),
          now,
        );

      this.insertMessage(input.sessionId, simulationId, "user", input.userReply, "user_reply", now, null);
      if (input.result.target_reply) {
        this.insertMessage(input.sessionId, simulationId, "target", input.result.target_reply, "model_result", now, null);
      }
      if (input.result.best_strategy) {
        this.insertMessage(
          input.sessionId,
          simulationId,
          "advisor",
          input.result.best_strategy,
          "model_result",
          now,
          input.result.judge ? { judge: input.result.judge } : null,
        );
      }
      const recommendedReply = input.result.recommended_reply_80 ?? input.result.recommended_reply;
      if (recommendedReply) {
        this.insertMessage(
          input.sessionId,
          simulationId,
          "copywriter",
          recommendedReply,
          "model_result",
          now,
          input.result.perfect_reply_100 ? { perfect_reply_100: input.result.perfect_reply_100 } : null,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getStats() {
    return {
      sessions: this.count("sessions"),
      simulations: this.count("simulations"),
      messages: this.count("messages"),
      datasetConsentedSessions: this.count("sessions WHERE consent_for_dataset = 1"),
      datasetConsentedSimulations: this.count(
        "simulations INNER JOIN sessions ON sessions.id = simulations.session_id WHERE sessions.consent_for_dataset = 1 AND simulations.consent_for_dataset = 1",
      ),
    };
  }

  deleteSessionForVisitor(visitorId: string, sessionId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM sessions WHERE visitor_id = ? AND id = ?")
      .run(visitorId, sessionId);
    return Number(result.changes) > 0;
  }

  clearHistoryForVisitor(visitorId: string): number {
    const result = this.db.prepare("DELETE FROM sessions WHERE visitor_id = ?").run(visitorId);
    return typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
  }

  getHistory(visitorId: string, limit = 30) {
    const rows = this.db
      .prepare(
        [
          "SELECT sessions.id AS session_id, sessions.created_at AS session_created_at,",
          "simulations.case_id, simulations.custom_case_json, simulations.result_json, simulations.created_at AS simulation_created_at",
          "FROM sessions",
          "INNER JOIN simulations ON simulations.session_id = sessions.id",
          "WHERE sessions.visitor_id = ?",
          "ORDER BY sessions.created_at DESC, simulations.created_at ASC",
        ].join(" "),
      )
      .all(visitorId) as Array<{
      session_id: string;
      session_created_at: string;
      case_id: string;
      custom_case_json: string | null;
      result_json: string;
      simulation_created_at: string;
    }>;

    const grouped = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = grouped.get(row.session_id) ?? [];
      list.push(row);
      grouped.set(row.session_id, list);
    }

    return Array.from(grouped.values())
      .slice(0, limit)
      .map((sessionRows) => {
        const last = sessionRows.at(-1)!;
        const rowResults = sessionRows.map((row) => ({
          row,
          result: safeJson(row.result_json) as SimulationResult,
        }));
        const result = rowResults.at(-1)!.result;
        const game = result.game;
        const customCase = last.custom_case_json ? (safeJson(last.custom_case_json) as RelationshipCase) : null;
        const rounds = game?.rounds ?? [];
        const resultsByTurn = new Map<number, SimulationResult>();
        for (const item of rowResults) {
          const turn = item.result.game?.turn_count;
          if (typeof turn === "number") {
            resultsByTurn.set(turn, item.result);
          }
        }
        const bestRound = rounds.reduce<GameState["rounds"][number] | null>(
          (best, round) => (!best || round.score_delta > best.score_delta ? round : best),
          null,
        );
        const worstRound = rounds.reduce<GameState["rounds"][number] | null>(
          (worst, round) => (!worst || round.score_delta < worst.score_delta ? round : worst),
          null,
        );

        return {
          session_id: last.session_id,
          case_id: last.case_id,
          created_at: sessionRows[0].session_created_at,
          updated_at: last.simulation_created_at,
          scene: customCase?.real_relationship_scene ?? last.case_id,
          relationship_stage_label: customCase?.relationship_stage_label ?? "未知阶段",
          risk_level: customCase?.risk_level ?? "unknown",
          is_custom: Boolean(customCase),
          final_score: game?.score ?? 0,
          final_title: game?.title ?? "谨慎修复",
          highest_score: game?.highest_score ?? 0,
          highest_title: game?.highest_title ?? "谨慎修复",
          turn_count: game?.turn_count ?? rounds.length,
          max_turns: game?.max_turns ?? 10,
          is_complete: Boolean(game?.is_complete),
          completion_reason: game?.completion_reason ?? null,
          best_turn: buildRoundSummary(bestRound, resultsByTurn),
          worst_turn: buildRoundSummary(worstRound, resultsByTurn),
        };
      });
  }

  getCompletedCaseIds(visitorId: string) {
    const rows = this.db
      .prepare(
        [
          "SELECT simulations.case_id, simulations.custom_case_json, simulations.result_json",
          "FROM simulations",
          "INNER JOIN sessions ON sessions.id = simulations.session_id",
          "WHERE sessions.visitor_id = ?",
          "ORDER BY simulations.created_at ASC",
        ].join(" "),
      )
      .all(visitorId) as Array<{
      case_id: string;
      custom_case_json: string | null;
      result_json: string;
    }>;

    const completed = new Set<string>();
    for (const row of rows) {
      if (row.custom_case_json) continue;
      const result = safeJson(row.result_json) as SimulationResult;
      if (result.game?.is_complete) {
        completed.add(row.case_id);
      }
    }
    return [...completed];
  }

  exportDatasetJsonl() {
    const rows = this.db
      .prepare(
        [
          "SELECT simulations.id, simulations.session_id, simulations.case_id, simulations.mode,",
          "simulations.custom_case_json, simulations.turns_json, simulations.user_reply, simulations.result_json, simulations.created_at",
          "FROM simulations",
          "INNER JOIN sessions ON sessions.id = simulations.session_id",
          "WHERE sessions.consent_for_dataset = 1 AND simulations.consent_for_dataset = 1",
          "ORDER BY simulations.created_at ASC",
        ].join(" "),
      )
      .all() as Array<{
      id: string;
      session_id: string;
      case_id: string;
      mode: SimulationMode;
      custom_case_json: string | null;
      turns_json: string;
      user_reply: string;
      result_json: string;
      created_at: string;
    }>;

    return rows
      .map((row) =>
        JSON.stringify({
          schema: "relationship-chat.dataset.v1",
          simulation_id: row.id,
          session_id: row.session_id,
          case_id: row.case_id,
          mode: row.mode,
          created_at: row.created_at,
          custom_case: row.custom_case_json ? maskSensitive(JSON.parse(row.custom_case_json)) : null,
          history: maskSensitive(JSON.parse(row.turns_json)),
          user_reply: maskSensitive(row.user_reply),
          model_outputs: maskSensitive(JSON.parse(row.result_json)),
        }),
      )
      .join("\n");
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        visitor_id TEXT NOT NULL,
        consent_for_dataset INTEGER NOT NULL DEFAULT 0,
        user_agent TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS simulations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        case_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        consent_for_dataset INTEGER NOT NULL DEFAULT 0,
        custom_case_json TEXT,
        turns_json TEXT NOT NULL,
        user_reply TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        simulation_id TEXT NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        meta_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_simulations_session_created ON simulations(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);
    `);
  }

  private insertMessage(
    sessionId: string,
    simulationId: string,
    role: ChatTurn["role"],
    text: string,
    source: string,
    createdAt: string,
    meta: unknown,
  ) {
    this.db
      .prepare(
        [
          "INSERT INTO messages (id, session_id, simulation_id, role, text, source, meta_json, created_at)",
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ].join(" "),
      )
      .run(randomUUID(), sessionId, simulationId, role, text, source, meta ? JSON.stringify(meta) : null, createdAt);
  }

  private count(fromClause: string) {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${fromClause}`).get() as CountRow;
    return row.count;
  }
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function buildRoundSummary(round: GameState["rounds"][number] | null, resultsByTurn: Map<number, SimulationResult>) {
  if (!round) return null;
  const result = resultsByTurn.get(round.turn);
  return {
    turn: round.turn,
    score_delta: round.score_delta,
    verdict: round.verdict,
    recommended_reply_80: result?.recommended_reply_80 ?? result?.recommended_reply ?? null,
    perfect_reply_100: result?.perfect_reply_100 ?? null,
  };
}

function maskSensitive(value: unknown): unknown {
  if (typeof value === "string") return maskSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => maskSensitive(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskSensitive(item)]));
  }
  return value;
}

function maskSensitiveText(value: string) {
  return value
    .replace(/\b1[3-9]\d{9}\b/g, "[PHONE]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL]")
    .replace(/((?:微信|wechat|wx)\s*(?:号|是|:|：)?\s*)[A-Z][A-Z0-9_-]{4,}/gi, "$1[WECHAT]");
}
