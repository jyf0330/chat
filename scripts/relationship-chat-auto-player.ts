import type { RelationshipCase, SimulationResult } from "./relationship-chat-storage.ts";

export type AutoPlayerStopReason = "stale_loop" | "natural_end";
export type AutoPlayerInputScheme = "recommended" | "repair";
const autoPlayerSchemeEnvKey = "RELATIONSHIP_CHAT_AUTO_PLAYER_SCHEME";

type ChooseAutoPlayerNextReplyInput = {
  currentCase: RelationshipCase;
  result: SimulationResult;
  previousUserReplies: string[];
};

export function resolveAutoPlayerInputScheme(value?: string): AutoPlayerInputScheme {
  const normalized = normalizeReply(value).toLowerCase();
  if (normalized === "repair" || normalized === "wrong-first") return "repair";
  return "recommended";
}

export function chooseAutoPlayerOpeningReply(
  currentCase: RelationshipCase,
  runStyle: string,
  scheme: AutoPlayerInputScheme = resolveAutoPlayerInputScheme(process.env[autoPlayerSchemeEnvKey]),
) {
  if (scheme === "repair" && isMistakeFirstStyle(runStyle)) return currentCase.wrong_reply;
  return currentCase.recommended_reply;
}

export function chooseAutoPlayerNextReply(input: ChooseAutoPlayerNextReplyInput) {
  const stopReason = shouldStopAutoPlayer(input.previousUserReplies);
  if (stopReason) return null;

  const recommended = normalizeReply(input.result.recommended_reply_80 ?? input.result.recommended_reply);
  const perfect = normalizeReply(input.result.perfect_reply_100);
  if (!recommended) return null;
  if (perfect && recommended === perfect) return null;

  const previous = input.previousUserReplies.map(normalizeReply).filter(Boolean);
  if (previous.includes(recommended)) return null;
  if (isNaturalClosingReply(recommended) && previous.some(isNaturalClosingReply)) return null;

  return recommended;
}

export function shouldStopAutoPlayer(previousUserReplies: string[]): AutoPlayerStopReason | null {
  const normalized = previousUserReplies.map(normalizeReply).filter(Boolean);
  if (normalized.length < 2) return null;

  const last = normalized.at(-1)!;
  const beforeLast = normalized.at(-2)!;
  if (last === beforeLast) return "stale_loop";
  if (normalized.length >= 3 && isNaturalClosingReply(last)) return "natural_end";
  return null;
}

function isMistakeFirstStyle(runStyle: string) {
  return /越界|施压|低分|错误|翻车|修复|wrong|bad|repair/i.test(runStyle);
}

function isNaturalClosingReply(reply: string) {
  return /晚安|明天(聊|见)|你先忙|先忙|不打扰|回头聊|早点休息|先休息|下次再聊/.test(reply);
}

function normalizeReply(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}
