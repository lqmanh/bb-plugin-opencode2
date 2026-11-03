import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { OPENCODE_PROVIDER_ID } from "../shared/settings-contract.ts";
import { errorMessage } from "../shared/errors.ts";
import { rememberBounded } from "../shared/collections.ts";

type ThreadEligibility = {
  providerId: string;
  parentThreadId: string | null;
  archivedAt: number | null;
  visibility: "visible" | "hidden";
  status: string;
};

export type BackgroundCompletionDecision = ThreadEligibility & {
  lastReadAt: number | null;
  latestAttentionAt: number;
  activeBackgroundCount: number;
  completionSequence: number;
  completionCreatedAt: number;
  lastNotifiedSequence: number;
};

function isEligibleThread(args: ThreadEligibility): boolean {
  return (
    args.providerId === OPENCODE_PROVIDER_ID &&
    args.parentThreadId === null &&
    args.archivedAt === null &&
    args.visibility === "visible" &&
    args.status === "idle"
  );
}

/**
 * BB core marks attention on top-level `active -> idle` only, so a background
 * task that finishes after the turn does not make the thread unread. Mark the
 * thread unread when the last task finishes and the completion has not been
 * read yet. This is a sidebar notification, not a transcript system message.
 */
export function shouldNotifyBackgroundCompletion(
  args: BackgroundCompletionDecision,
): boolean {
  if (!isEligibleThread(args)) return false;
  if (args.activeBackgroundCount > 0) return false;
  if (args.completionSequence <= args.lastNotifiedSequence) return false;
  if (args.lastReadAt === null) return false;
  if (args.lastReadAt < args.latestAttentionAt) return false;
  return args.completionCreatedAt > args.lastReadAt;
}

export function registerBackgroundCompletionNotifications(bb: BbPluginApi) {
  const lastNotified = new Map<string, number>();

  bb.events.on("experimental_thread.events", ({ thread }) => {
    if (!isEligibleThread(thread)) return;
    void (async () => {
      try {
        const [entry] = await bb.sdk.threads.list({
          threadIds: [thread.id],
        });
        if (!entry || entry.status !== "idle") return;
        const activeBackgroundCount =
          entry.activity.activeBackgroundAgentCount +
          entry.activity.activeBackgroundCommandCount;
        if (activeBackgroundCount > 0) return;
        const [completion] = await bb.sdk.threads.events.list({
          threadId: thread.id,
          types: ["item/backgroundTask/completed"],
          order: "desc",
          limit: "1",
        });
        if (!completion) return;
        const lastNotifiedSequence = lastNotified.get(thread.id) ?? 0;
        if (completion.seq <= lastNotifiedSequence) return;
        const remember = () =>
          rememberBounded(lastNotified, thread.id, completion.seq, 1_000);
        if (
          shouldNotifyBackgroundCompletion({
            providerId: thread.providerId,
            parentThreadId: thread.parentThreadId,
            archivedAt: thread.archivedAt,
            visibility: thread.visibility,
            status: thread.status,
            lastReadAt: thread.lastReadAt,
            latestAttentionAt: thread.latestAttentionAt,
            activeBackgroundCount,
            completionSequence: completion.seq,
            completionCreatedAt: completion.createdAt,
            lastNotifiedSequence,
          })
        )
          await bb.sdk.threads.markUnread({ threadId: thread.id });
        remember();
      } catch (error) {
        bb.log.warn(
          `Could not notify for an OpenCode background task: ${errorMessage(error)}`,
        );
      }
    })();
  });
}
