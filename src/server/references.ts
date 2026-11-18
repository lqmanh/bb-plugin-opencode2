import type {
  BbPluginApi,
  ExperimentalHostClient,
  PluginMentionItem,
  PluginMentionSearchContext,
} from "@get-bb/plugin-sdk";
import {
  REFERENCE_PROVIDER_ID,
  decodeReferenceId,
  encodeReferenceId,
  referenceContext,
  referenceNotFound,
} from "../shared/references.ts";
import {
  OPENCODE_PROVIDER_ID,
  opencodeHostContract,
  type ReferenceInfo,
} from "../shared/settings-contract.ts";

type ReferenceHost = ExperimentalHostClient<typeof opencodeHostContract>;
type ReferenceLocation = { hostId: string; directory: string };

async function threadLocation(
  bb: BbPluginApi,
  threadId: string,
): Promise<ReferenceLocation | undefined> {
  const [thread] = await bb.sdk.threads.list({ threadIds: [threadId] });
  if (!thread || thread.providerId !== OPENCODE_PROVIDER_ID) return undefined;
  if (!thread.environmentHostId || !thread.environmentPath) return undefined;
  return {
    hostId: thread.environmentHostId,
    directory: thread.environmentPath,
  };
}

async function projectLocation(
  bb: BbPluginApi,
  projectId: string,
): Promise<ReferenceLocation | undefined> {
  const project = await bb.sdk.projects.get({ projectId });
  const source =
    project.sources.find((item) => item.isDefault) ?? project.sources[0];
  return source ? { hostId: source.hostId, directory: source.path } : undefined;
}

function matchesQuery(reference: ReferenceInfo, query: string): boolean {
  if (!query) return true;
  return (
    reference.name.toLocaleLowerCase().includes(query) ||
    (reference.description?.toLocaleLowerCase().includes(query) ?? false)
  );
}

async function searchReferences(
  bb: BbPluginApi,
  host: ReferenceHost,
  context: PluginMentionSearchContext,
): Promise<PluginMentionItem[]> {
  try {
    let location: ReferenceLocation | undefined;
    if (context.threadId) location = await threadLocation(bb, context.threadId);
    else if (context.projectId)
      location = await projectLocation(bb, context.projectId);
    if (!location) return [];
    const { references } = await host.call(
      "references/list",
      { directory: location.directory },
      { hostId: location.hostId },
    );
    const query = context.query.trim().toLocaleLowerCase();
    return references
      .filter(
        (reference) =>
          reference.hidden !== true && matchesQuery(reference, query),
      )
      .map((reference) => ({
        id: encodeReferenceId({
          ...location,
          alias: reference.name,
        }),
        title: reference.name,
        subtitle: reference.description || reference.path,
      }));
  } catch {
    return [];
  }
}

async function resolveReference(
  host: ReferenceHost,
  itemId: string,
): Promise<{ context: string }> {
  const target = decodeReferenceId(itemId);
  if (!target) return { context: referenceNotFound() };
  try {
    const { reference } = await host.call(
      "references/get",
      { directory: target.directory, alias: target.alias },
      { hostId: target.hostId },
    );
    if (!reference) return { context: referenceNotFound(target.alias) };
    return {
      context: referenceContext({
        alias: reference.name,
        path: reference.path,
        ...(reference.description
          ? { description: reference.description }
          : {}),
      }),
    };
  } catch {
    return { context: referenceNotFound(target.alias) };
  }
}

export function registerReferenceMentions(
  bb: BbPluginApi,
  host: ReferenceHost,
) {
  bb.ui.registerMentionProvider({
    id: REFERENCE_PROVIDER_ID,
    label: "OpenCode references",
    triggers: ["@"],
    search: (context) => searchReferences(bb, host, context),
    resolve: (itemId) => resolveReference(host, itemId),
  });
}
