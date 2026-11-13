import { z } from "zod";

/** The mention provider id used for OpenCode references. */
export const REFERENCE_PROVIDER_ID = "reference";

const referenceTargetSchema = z
  .object({
    hostId: z.string().min(1),
    directory: z.string().min(1),
    alias: z.string().min(1),
  })
  .strict();

export type ReferenceTarget = z.infer<typeof referenceTargetSchema>;

/** A reference directory that can be attached to an OpenCode prompt. */
export type ReferenceFile = {
  alias: string;
  path: string;
  description?: string;
};

const REFERENCE_ID_PREFIX = "ref1.";

export function encodeReferenceId(target: ReferenceTarget): string {
  return `${REFERENCE_ID_PREFIX}${Buffer.from(
    JSON.stringify(target),
    "utf8",
  ).toString("base64url")}`;
}

export function decodeReferenceId(value: string): ReferenceTarget | undefined {
  if (!value.startsWith(REFERENCE_ID_PREFIX)) return undefined;
  try {
    const parsed = referenceTargetSchema.safeParse(
      JSON.parse(
        Buffer.from(
          value.slice(REFERENCE_ID_PREFIX.length),
          "base64url",
        ).toString("utf8"),
      ),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Read a reference target from the namespaced item id in a prompt mention. */
export function referenceTargetFromMentionItemId(
  itemId: string,
): ReferenceTarget | undefined {
  const prefix = `${REFERENCE_PROVIDER_ID}:`;
  return itemId.startsWith(prefix)
    ? decodeReferenceId(itemId.slice(prefix.length))
    : undefined;
}

export function referenceContext(reference: {
  alias: string;
  path: string;
  description?: string;
}): string {
  return [
    `OpenCode reference @${reference.alias}`,
    `Path: ${reference.path}`,
    ...(reference.description ? [`Description: ${reference.description}`] : []),
  ].join("\n");
}

export function referenceNotFound(alias?: string): string {
  return alias
    ? `OpenCode reference @${alias} was not found. It may have been removed.`
    : "OpenCode reference was not found. It may have been removed.";
}
