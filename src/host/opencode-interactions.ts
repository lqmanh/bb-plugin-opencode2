import {
  experimental_presentationDetail as presentationDetail,
  experimental_presentationTitle as presentationTitle,
} from "@get-bb/plugin-sdk/provider-bridge";
import { emit, requestRuntime } from "./bridge-runtime.ts";
import {
  approvalPermissionReply,
  automaticPermissionReply,
  permissionReplyBody,
} from "./prompt.ts";
import { itemKey } from "./timeline.ts";
import {
  errorMessage,
  inputRecord,
  stringValue,
  type ActiveTurn,
  type OpenCodeApi,
  type OpenCodePermissionReply,
  type OpenCodeRecord,
  type SessionState,
} from "./types.ts";

type RecordValue = OpenCodeRecord;

const QUESTION_WAIT_TIMEOUT_MS = 60_000;

export class OpenCodeInteractions {
  private readonly questionWaiters = new Map<
    string,
    {
      session: SessionState;
      active: ActiveTurn;
      resolve(form: RecordValue | undefined): void;
    }
  >();
  private readonly earlyQuestionForms = new Map<string, RecordValue>();

  constructor(
    private readonly api: OpenCodeApi,
    private readonly emitTimeline: typeof emit = emit,
  ) {}

  private questionKey(sessionId: string, callId: string) {
    return `${sessionId}:${callId}`;
  }

  private questionCallId(form: RecordValue) {
    const metadata = inputRecord(form.metadata);
    return stringValue(inputRecord(metadata.tool).id);
  }

  /**
   * Never rejects: a reply can 404 when the request was already answered
   * elsewhere (another client, or OpenCode cancelled it), and an unhandled
   * rejection would take the whole bridge process down.
   */
  async handlePermission(session: SessionState, data: RecordValue) {
    try {
      await this.resolvePermission(session, data);
    } catch (error) {
      process.stderr.write(
        `[opencode2] Could not answer an OpenCode permission request: ${errorMessage(error)}\n`,
      );
    }
  }

  private async resolvePermission(session: SessionState, data: RecordValue) {
    const active = session.active;
    if (!active) return;
    const sessionId = stringValue(data.sessionID);
    const requestId = stringValue(data.id);
    if (!sessionId || !requestId) return;
    const action = stringValue(data.action) ?? "";
    const automaticReply = automaticPermissionReply(
      session.permissionMode,
      session.disableSubagents,
      action,
    );
    if (automaticReply) {
      await this.replyPermission(sessionId, requestId, automaticReply);
      return;
    }
    const tool = action || "OpenCode permission";
    const message = stringValue(data.message);
    const source = inputRecord(data.source);
    const payload = {
      kind: "approval",
      subject: {
        kind: "tool_use",
        itemId: stringValue(source.id) ?? requestId,
        tool,
        presentation: {
          label: {
            pending: "Requesting permission",
            completed: "Permission handled",
          },
          icon: { glyph: "Shield" },
          ...(presentationTitle(tool)
            ? { title: presentationTitle(tool) }
            : {}),
          ...(message ? { detail: presentationDetail(message) } : {}),
        },
      },
      reason: message ?? null,
      availableDecisions: ["allow_once", "allow_for_session", "deny"],
    };
    try {
      const result = await requestRuntime(
        "interaction/request",
        {
          providerThreadId: session.providerThreadId,
          threadId: session.bbThreadId,
          turnId: active.providerTurnId,
          payload,
        },
        { signal: active.abortController.signal },
      );
      const decision = result?.resolution?.decision;
      const reply =
        session.active === active
          ? approvalPermissionReply(decision)
          : "reject";
      await this.replyPermission(sessionId, requestId, reply);
    } catch {
      await this.replyPermission(sessionId, requestId, "reject").catch(
        () => {},
      );
    }
  }

  private async replyPermission(
    sessionId: string,
    requestId: string,
    decision: OpenCodePermissionReply,
  ) {
    const api = await this.api();
    await api.permission.reply({
      sessionID: sessionId,
      requestID: requestId,
      ...permissionReplyBody(decision),
    });
  }

  /** Route a `form.created` event to the question tool that raised it. */
  handleCreatedForm(session: SessionState, form: RecordValue) {
    const callId = this.questionCallId(form);
    if (!callId) return;
    const key = this.questionKey(session.providerThreadId, callId);
    const waiter = this.questionWaiters.get(key);
    if (!waiter) {
      this.earlyQuestionForms.set(key, form);
      return;
    }
    this.questionWaiters.delete(key);
    waiter.resolve(form);
  }

  cancelQuestionWaiters(session: SessionState, active: ActiveTurn) {
    for (const [key, waiter] of this.questionWaiters) {
      if (
        waiter.session.providerThreadId !== session.providerThreadId ||
        waiter.active !== active
      )
        continue;
      this.questionWaiters.delete(key);
      waiter.resolve(undefined);
    }
    const prefix = `${session.providerThreadId}:`;
    for (const key of this.earlyQuestionForms.keys())
      if (key.startsWith(prefix)) this.earlyQuestionForms.delete(key);
  }

  private waitForQuestionForm(
    session: SessionState,
    active: ActiveTurn,
    callId: string,
  ): Promise<RecordValue | undefined> {
    const key = this.questionKey(session.providerThreadId, callId);
    const early = this.earlyQuestionForms.get(key);
    if (early) {
      this.earlyQuestionForms.delete(key);
      return Promise.resolve(early);
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.questionWaiters.delete(key);
        resolve(undefined);
      }, QUESTION_WAIT_TIMEOUT_MS);
      this.questionWaiters.set(key, {
        session,
        active,
        resolve(form) {
          clearTimeout(timeout);
          resolve(form);
        },
      });
    });
  }

  async cancelQuestionForm(session: SessionState, formId: string) {
    await this.api()
      .then((api) =>
        api.session.form.cancel({
          sessionID: session.providerThreadId,
          formID: formId,
        }),
      )
      .catch(() => {});
  }

  private closeQuestion(
    session: SessionState,
    active: ActiveTurn,
    callId: string,
    status: "completed" | "failed",
    text: string,
  ) {
    const item = active.opened.get(callId) ?? {
      type: "tool",
      tool: "question",
      args: {},
    };
    if (status === "completed") item.result = text;
    else item.error = text;
    active.opened.delete(callId);
    active.openQuestions.delete(callId);
    active.settledTools.add(callId);
    this.emitTimeline(session.bbThreadId, [
      {
        kind: "item.close",
        key: itemKey(callId, "tool"),
        status,
        ...(status === "completed" ? { resultText: text } : {}),
        item,
        providerTurnId: active.providerTurnId,
      },
    ]);
  }

  async handleQuestion(
    session: SessionState,
    active: ActiveTurn,
    callId: string,
  ) {
    const form = await this.waitForQuestionForm(session, active, callId);
    if (session.active !== active || !active.opened.has(callId)) return;
    if (!form) {
      this.closeQuestion(
        session,
        active,
        callId,
        "failed",
        "OpenCode question went unanswered (no prompt received)",
      );
      return;
    }
    await this.answerQuestionForm(session, active, callId, form);
  }

  private async answerQuestionForm(
    session: SessionState,
    active: ActiveTurn,
    callId: string,
    form: RecordValue,
  ) {
    const formId = stringValue(form.id);
    if (!formId) {
      this.closeQuestion(
        session,
        active,
        callId,
        "failed",
        "OpenCode question did not include a form ID",
      );
      return;
    }
    active.openQuestions.set(callId, formId);
    const fields = (Array.isArray(form.fields) ? form.fields : [])
      .slice(0, 4)
      .map(inputRecord);
    if (!fields.length) {
      this.closeQuestion(
        session,
        active,
        callId,
        "failed",
        "OpenCode question had no prompts",
      );
      return;
    }
    const questions = fields.map((field) => {
      const key = String(field.key ?? field.title ?? "q");
      const fieldType = stringValue(field.type);
      const options = Array.isArray(field.options)
        ? field.options.slice(0, 4).map((value: unknown) => {
            const option = inputRecord(value);
            return {
              label: stringValue(option.label) ?? String(option.value ?? ""),
              value: String(option.value ?? option.label ?? ""),
              ...(stringValue(option.description)
                ? { description: stringValue(option.description) }
                : {}),
            };
          })
        : undefined;
      return {
        id: key,
        prompt:
          stringValue(field.description) ??
          stringValue(field.title) ??
          "Question",
        ...(stringValue(field.title)
          ? { shortLabel: stringValue(field.title) }
          : {}),
        multiSelect: fieldType === "multiselect",
        allowFreeText: field.custom !== false,
        ...(options?.length ? { options } : {}),
      };
    });
    let resolution: RecordValue | undefined;
    try {
      const result = await requestRuntime(
        "interaction/request",
        {
          providerThreadId: session.providerThreadId,
          threadId: session.bbThreadId,
          turnId: active.providerTurnId,
          payload: { kind: "user_question", questions },
        },
        { signal: active.abortController.signal },
      );
      resolution = result?.resolution;
    } catch {
      resolution = undefined;
    }
    if (session.active !== active || !active.opened.has(callId)) return;
    const answers: RecordValue | undefined =
      resolution?.kind === "user_answer" ? resolution.answers : undefined;
    if (!answers) {
      await this.cancelQuestionForm(session, formId);
      this.closeQuestion(
        session,
        active,
        callId,
        "failed",
        "Question dismissed",
      );
      return;
    }
    const answer: RecordValue = {};
    const summary: string[] = [];
    for (const field of fields) {
      const key = String(field.key ?? field.title ?? "q");
      const fieldType = stringValue(field.type);
      const entry: RecordValue = answers[key] ?? {};
      const selected: unknown[] = Array.isArray(entry.selected)
        ? entry.selected
        : [];
      const freeText = stringValue(entry.freeText);
      if (fieldType === "multiselect") {
        const values = [
          ...(freeText ? [freeText] : []),
          ...selected.map(String).filter((value) => value.length > 0),
        ];
        if (!values.length) {
          await this.cancelQuestionForm(session, formId);
          this.closeQuestion(
            session,
            active,
            callId,
            "failed",
            "Question dismissed",
          );
          return;
        }
        answer[key] = values;
        summary.push(values.join(", "));
        continue;
      }
      if (fieldType === "boolean") {
        const raw = (freeText ?? (selected.length ? String(selected[0]) : ""))
          .trim()
          .toLowerCase();
        if (!raw) {
          await this.cancelQuestionForm(session, formId);
          this.closeQuestion(
            session,
            active,
            callId,
            "failed",
            "Question dismissed",
          );
          return;
        }
        const value =
          raw === "true" || raw === "yes" || raw === "y" || raw === "1";
        answer[key] = value;
        summary.push(String(value));
        continue;
      }
      if (fieldType === "number" || fieldType === "integer") {
        const raw = (
          freeText ?? (selected.length ? String(selected[0]) : "")
        ).trim();
        if (!raw) {
          await this.cancelQuestionForm(session, formId);
          this.closeQuestion(
            session,
            active,
            callId,
            "failed",
            "Question dismissed",
          );
          return;
        }
        const numeric = Number(raw);
        answer[key] = Number.isFinite(numeric) ? numeric : raw;
        summary.push(raw);
        continue;
      }
      const value = freeText ?? (selected.length ? String(selected[0]) : "");
      if (!value) {
        await this.cancelQuestionForm(session, formId);
        this.closeQuestion(
          session,
          active,
          callId,
          "failed",
          "Question dismissed",
        );
        return;
      }
      answer[key] = value;
      summary.push(value);
    }
    try {
      const api = await this.api();
      await api.session.form.reply({
        sessionID: session.providerThreadId,
        formID: formId,
        answer,
      });
    } catch (error) {
      this.closeQuestion(
        session,
        active,
        callId,
        "failed",
        errorMessage(error),
      );
      return;
    }
    this.closeQuestion(
      session,
      active,
      callId,
      "completed",
      summary.join("\n"),
    );
  }
}
