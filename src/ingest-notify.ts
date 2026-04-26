import { loadDailyPost, recordDailyPost } from "./menu-store";
import { postSlackAdminMessage, postSlackThreadReply } from "./slack";
import { CAFETERIA_TZ } from "./tz";
import type {
  Env,
  IngestResult,
  MenuChange,
  NormalizedEmailMessage,
  PostedMenuRecord,
} from "./types";

interface ThreadReplyTarget {
  change: MenuChange;
  record: PostedMenuRecord;
}

export async function handleIngestSideEffects(
  env: Env,
  message: NormalizedEmailMessage,
  result: IngestResult,
): Promise<void> {
  if (result.ignored) {
    return;
  }

  const isParseError = !result.parsed;
  const isFollowUp = result.parsed && result.followUp;
  if (!isParseError && !isFollowUp) {
    return;
  }

  const replyTargets = isFollowUp
    ? await collectThreadReplyTargets(env, result.changedDates)
    : [];

  try {
    await postSlackAdminMessage(
      env,
      formatAdminNotification(message, result, replyTargets.length),
    );
  } catch (error) {
    console.error("Admin notification failed:", error);
  }

  for (const target of replyTargets) {
    try {
      await postSlackThreadReply(
        env,
        target.record.channel,
        target.record.ts,
        formatThreadReply(target.change, target.record, message.receivedAt),
      );
      await recordDailyPost(env, {
        ...target.record,
        special: target.change.newSpecial ?? "",
        postedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error(`Thread reply failed for ${target.change.date}:`, error);
    }
  }
}

async function collectThreadReplyTargets(
  env: Env,
  changedDates: MenuChange[],
): Promise<ThreadReplyTarget[]> {
  const targets: ThreadReplyTarget[] = [];
  for (const change of changedDates) {
    if (!change.newSpecial) {
      continue;
    }
    const record = await loadDailyPost(env, change.date);
    if (!record || !record.ts || !record.channel) {
      continue;
    }
    if (record.special === change.newSpecial) {
      continue;
    }
    targets.push({ change, record });
  }
  return targets;
}

export function formatAdminNotification(
  message: NormalizedEmailMessage,
  result: IngestResult,
  threadReplyCount: number,
): string {
  const lines: string[] = [];
  const receivedLabel = formatInstant(message.receivedAt);
  const sender = message.from || "(unknown sender)";
  const subjectLabel = message.subject || "(no subject)";

  if (!result.parsed) {
    lines.push(`*Parse error on cafeteria email* (received ${receivedLabel})`);
    lines.push(`From: ${sender}`);
    lines.push(`Subject: ${subjectLabel}`);
    if (result.weekStart) {
      lines.push(`Week (best guess): ${result.weekStart}`);
    }
    if (result.error) {
      lines.push(`Error: ${result.error}`);
    }
    lines.push("Check `/admin/messages` for the raw stored email.");
    return lines.join("\n");
  }

  const verdict = result.becameAuthoritative
    ? "Auto-applied as the new authoritative menu."
    : "Stored as an additional candidate; existing menu remains authoritative.";
  lines.push(`*Follow-up cafeteria email detected* (received ${receivedLabel})`);
  lines.push(`From: ${sender}`);
  lines.push(`Subject: ${subjectLabel}`);
  if (result.weekStart) {
    lines.push(`Week: ${result.weekStart}`);
  }
  if (result.previousAuthoritativeSubject && result.previousAuthoritativeSubject !== result.newAuthoritativeSubject) {
    lines.push(`Previous authoritative subject: ${result.previousAuthoritativeSubject}`);
  }
  lines.push(verdict);

  if (result.changedDates.length > 0) {
    lines.push("Changes:");
    for (const change of result.changedDates) {
      lines.push(`• ${change.date}: ${formatChangeLine(change)}`);
    }
  } else {
    lines.push("No per-date changes (authoritative menu unchanged).");
  }

  if (threadReplyCount > 0) {
    lines.push(
      `Posted ${threadReplyCount} thread ${threadReplyCount === 1 ? "reply" : "replies"} on the original daily post(s).`,
    );
  }
  return lines.join("\n");
}

export function formatThreadReply(
  change: MenuChange,
  record: PostedMenuRecord,
  receivedAt: string,
): string {
  const wasLine = record.special || change.previousSpecial || "(unknown)";
  const nowLine = change.newSpecial || "(removed)";
  return [
    `Heads up — the cafeteria sent a correction (email received ${formatInstant(receivedAt)}).`,
    `The ${change.date} menu has been updated.`,
    `Was: ${wasLine}`,
    `Now: ${nowLine}`,
  ].join("\n");
}

function formatChangeLine(change: MenuChange): string {
  const previous = change.previousSpecial ?? "(none)";
  const next = change.newSpecial ?? "(removed)";
  return `${previous} → ${next}`;
}

function formatInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CAFETERIA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(date);
}
