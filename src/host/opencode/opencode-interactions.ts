import {
  experimental_presentationDetail as presentationDetail,
  experimental_presentationTitle as presentationTitle,
  USER_QUESTION_MAX_OPTIONS,
  USER_QUESTION_MAX_QUESTIONS,
} from "@get-bb/plugin-sdk/provider-bridge";
import { errorMessage } from "../../shared/errors.ts";
import { emit, requestRuntime } from "../bridge/bridge-runtime.ts";
import { itemKey } from "../timeline/timeline.ts";
import {
  inputRecord,
  stringValue,
  type ActiveTurn,
  type InteractionContext,
  type OpenCodeApi,
  type OpenCodePermissionReply,
  type OpenCodeRecord,
  type SessionState,
} from "../types.ts";
import {
  approvalPermissionReply,
  automaticPermissionReply,
  permissionReplyBody,
} from "./prompt.ts";

type RecordValue = OpenCodeRecord;

const QUESTION_WAIT_TIMEOUT_MS = 60_000;
const MAX_FORM_QUESTIONS = USER_QUESTION_MAX_QUESTIONS;
const MAX_FORM_OPTIONS = USER_QUESTION_MAX_OPTIONS;

const SUPPORTED_FIELD_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "multiselect",
]);

export type InteractionRequest = typeof requestRuntime<OpenCodeRecord>;

type FormPlan =
  | {
      questions: RecordValue[];
      fields: RecordValue[];
      hiddenAnswers: RecordValue;
    }
  | { error: string };

type CoercedAnswer =
  | { value?: unknown; text?: string; error?: never }
  | { error: string; value?: never; text?: never };

function fieldDefault(field: RecordValue): unknown {
  const value = field.default;
  if (value === undefined) return undefined;
  if (field.type === "multiselect")
    return Array.isArray(value) ? value.map(String) : undefined;
  if (field.type === "boolean")
    return typeof value === "boolean" ? value : undefined;
  if (field.type === "number" || field.type === "integer")
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  if (field.type === "string")
    return typeof value === "string" ? value : undefined;
  return undefined;
}

function allowFreeText(field: RecordValue): boolean {
  if (field.type === "string") {
    const options = Array.isArray(field.options) ? field.options : [];
    return options.length === 0 || field.custom === true;
  }
  if (field.type === "multiselect") return field.custom === true;
  return true;
}

function questionOptions(field: RecordValue): RecordValue[] {
  if (field.type === "boolean")
    return [
      { value: "true", label: "Yes" },
      { value: "false", label: "No" },
    ];
  return (Array.isArray(field.options) ? field.options : []).map((value) => {
    const option = inputRecord(value);
    const label = stringValue(option.label) ?? String(option.value ?? "");
    return {
      label,
      value: String(option.value ?? option.label ?? ""),
      ...(stringValue(option.description)
        ? { description: stringValue(option.description) }
        : {}),
    };
  });
}

function questionForField(field: RecordValue): RecordValue {
  const key = String(field.key);
  const options = questionOptions(field);
  return {
    id: key,
    prompt:
      stringValue(field.description) ?? stringValue(field.title) ?? "Question",
    ...(stringValue(field.title)
      ? { shortLabel: stringValue(field.title) }
      : {}),
    multiSelect: field.type === "multiselect",
    allowFreeText: allowFreeText(field),
    ...(options.length ? { options } : {}),
  };
}

/**
 * Turn an OpenCode form into BB's native question payload. Forms that use a
 * schema BB cannot represent are cancelled with a model-facing reason instead
 * of blocking the turn.
 */
export function planFormQuestions(form: RecordValue): FormPlan {
  const rawFields = (Array.isArray(form.fields) ? form.fields : []).map(
    inputRecord,
  );
  if (rawFields.length === 0) return { error: "OpenCode form had no fields" };
  const hidden: RecordValue[] = [];
  const visible: RecordValue[] = [];
  for (const field of rawFields) {
    const type = stringValue(field.type);
    if (type === "external")
      return {
        error: "OpenCode form uses an external step that BB cannot show",
      };
    if (!type || !SUPPORTED_FIELD_TYPES.has(type))
      return {
        error: `OpenCode form uses an unsupported ${type ?? "unknown"} field`,
      };
    const key = stringValue(field.key);
    if (!key) return { error: "OpenCode form field has no key" };
    if (Array.isArray(field.when) && field.when.length > 0)
      return {
        error: "OpenCode form uses conditional fields that BB cannot show",
      };
    if (field.hidden === true) {
      hidden.push(field);
      continue;
    }
    const options = Array.isArray(field.options) ? field.options : [];
    if (options.length > MAX_FORM_OPTIONS)
      return {
        error: `OpenCode form field "${key}" has more than ${MAX_FORM_OPTIONS} options`,
      };
    if (type === "multiselect" && options.length === 0 && field.custom !== true)
      return { error: `OpenCode form field "${key}" has no options` };
    for (const option of options) {
      const record = inputRecord(option);
      if (!stringValue(record.value) && !stringValue(record.label))
        return {
          error: `OpenCode form field "${key}" has an option without a value`,
        };
    }
    visible.push(field);
  }
  if (visible.length === 0)
    return { error: "OpenCode form has no visible fields" };
  if (visible.length > MAX_FORM_QUESTIONS)
    return {
      error: `OpenCode form has more than ${MAX_FORM_QUESTIONS} questions`,
    };
  const hiddenAnswers: RecordValue = {};
  for (const field of hidden) {
    const key = String(field.key);
    const value = fieldDefault(field);
    if (value === undefined && field.required === true)
      return {
        error: `OpenCode form field "${key}" is hidden and required without a default`,
      };
    if (value !== undefined) hiddenAnswers[key] = value;
  }
  return {
    questions: visible.map(questionForField),
    fields: visible,
    hiddenAnswers,
  };
}

function stringFormatError(
  format: unknown,
  key: string,
  value: string,
): string | undefined {
  if (format === "email")
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
      ? undefined
      : `"${key}" must be an email address`;
  if (format === "uri") {
    try {
      new URL(value);
      return undefined;
    } catch {
      return `"${key}" must be a URL`;
    }
  }
  if (format === "date") {
    const date = new Date(`${value}T00:00:00.000Z`);
    const valid =
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !Number.isNaN(date.getTime()) &&
      date.toISOString().slice(0, 10) === value;
    return valid ? undefined : `"${key}" must be a date (YYYY-MM-DD)`;
  }
  if (format === "date-time")
    return Number.isNaN(Date.parse(value))
      ? `"${key}" must be a date and time`
      : undefined;
  return undefined;
}

function emptyAnswer(field: RecordValue, key: string): CoercedAnswer {
  const fallback = fieldDefault(field);
  const unanswered = {
    error: `The user left required field "${key}" unanswered`,
  };
  if (fallback !== undefined) {
    if (
      field.required === true &&
      (fallback === "" || (Array.isArray(fallback) && fallback.length === 0))
    )
      return unanswered;
    return {
      value: fallback,
      text: Array.isArray(fallback) ? fallback.join(", ") : String(fallback),
    };
  }
  if (field.required === true) return unanswered;
  return {};
}

function coerceField(
  field: RecordValue,
  selected: readonly string[],
  freeText: string | undefined,
): CoercedAnswer {
  const type = stringValue(field.type) ?? "string";
  const key = String(field.key);
  if (type === "multiselect") {
    const values = [
      ...new Set([
        ...selected.filter(Boolean),
        ...(freeText && field.custom === true ? [freeText] : []),
      ]),
    ];
    if (values.length === 0) return emptyAnswer(field, key);
    if (typeof field.minItems === "number" && values.length < field.minItems)
      return { error: `Select at least ${field.minItems} for "${key}"` };
    if (typeof field.maxItems === "number" && values.length > field.maxItems)
      return { error: `Select at most ${field.maxItems} for "${key}"` };
    return { value: values, text: values.join(", ") };
  }
  if (type === "boolean") {
    const raw = (freeText ?? selected[0] ?? "").trim().toLowerCase();
    if (!raw) return emptyAnswer(field, key);
    if (["true", "yes", "y", "1"].includes(raw))
      return { value: true, text: "Yes" };
    if (["false", "no", "n", "0"].includes(raw))
      return { value: false, text: "No" };
    return { error: `Expected yes or no for "${key}"` };
  }
  if (type === "number" || type === "integer") {
    const raw = (freeText ?? selected[0] ?? "").trim();
    if (!raw) return emptyAnswer(field, key);
    const value = Number(raw);
    if (!Number.isFinite(value))
      return { error: `Expected a number for "${key}"` };
    if (type === "integer" && !Number.isInteger(value))
      return { error: `Expected an integer for "${key}"` };
    if (typeof field.minimum === "number" && value < field.minimum)
      return { error: `"${key}" must be at least ${field.minimum}` };
    if (typeof field.maximum === "number" && value > field.maximum)
      return { error: `"${key}" must be at most ${field.maximum}` };
    return { value, text: raw };
  }
  const value = freeText ?? selected[0] ?? "";
  if (!value) return emptyAnswer(field, key);
  const options = questionOptions(field);
  if (
    field.custom !== true &&
    options.length > 0 &&
    !options.some((option) => option.value === value)
  )
    return { error: `Choose one of the listed options for "${key}"` };
  if (typeof field.minLength === "number" && value.length < field.minLength)
    return { error: `"${key}" is too short` };
  if (typeof field.maxLength === "number" && value.length > field.maxLength)
    return { error: `"${key}" is too long` };
  if (typeof field.pattern === "string") {
    try {
      if (!new RegExp(field.pattern).test(value))
        return { error: `"${key}" has an invalid format` };
    } catch {
      return { error: `"${key}" has an invalid format` };
    }
  }
  const formatError = stringFormatError(field.format, key, value);
  if (formatError) return { error: formatError };
  return { value, text: value };
}

/** Map BB's question resolution onto the form's typed field values. */
export function answerFormFields(
  fields: readonly RecordValue[],
  hiddenAnswers: RecordValue,
  answers: RecordValue,
): { answer: RecordValue; summary: string[] } | { error: string } {
  const answer: RecordValue = { ...hiddenAnswers };
  const summary: string[] = [];
  for (const field of fields) {
    const key = String(field.key);
    const entry = inputRecord(answers[key]);
    const selected = Array.isArray(entry.selected)
      ? entry.selected.map(String)
      : [];
    const freeText = stringValue(entry.freeText);
    const result = coerceField(field, selected, freeText);
    if (result.error) return { error: result.error };
    if (result.value === undefined) continue;
    answer[key] = result.value;
    summary.push(
      `${stringValue(field.title) ?? key}: ${result.text ?? String(result.value)}`,
    );
  }
  return { answer, summary };
}

export function interactiveTurn(
  session: SessionState,
  active: ActiveTurn,
): InteractionContext {
  return {
    providerTurnId: active.providerTurnId,
    formSessionId: session.providerThreadId,
    background: false,
    abortController: active.abortController,
    opened: active.opened,
    openQuestions: active.openQuestions,
    settledTools: active.settledTools,
    questionWaiters: active.questionWaiters,
    earlyQuestionForms: active.earlyQuestionForms,
    settledForms: active.settledForms,
    ownForms: active.ownForms,
    settledPermissions: active.settledPermissions,
    ownPermissionReplies: active.ownPermissionReplies,
  };
}

function activeInteraction(session: SessionState) {
  return session.active ? interactiveTurn(session, session.active) : undefined;
}

export function backgroundInteraction(
  formSessionId: string,
): InteractionContext {
  return {
    providerTurnId: null,
    formSessionId,
    background: true,
    abortController: new AbortController(),
    opened: new Map(),
    openQuestions: new Map(),
    settledTools: new Set(),
    questionWaiters: new Map(),
    earlyQuestionForms: new Map(),
    settledForms: new Map(),
    ownForms: new Set(),
    settledPermissions: new Set(),
    ownPermissionReplies: new Set(),
  };
}

function turnId(context: InteractionContext) {
  return context.providerTurnId
    ? { providerTurnId: context.providerTurnId }
    : {};
}

export class OpenCodeInteractions {
  private readonly interactions: InteractionRequest;

  constructor(
    private readonly api: OpenCodeApi,
    private readonly emitTimeline: typeof emit = emit,
    requestInteraction?: InteractionRequest,
  ) {
    this.interactions =
      requestInteraction ??
      ((method, params, options) => requestRuntime(method, params, options));
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
  async handlePermission(
    session: SessionState,
    data: RecordValue,
    context: InteractionContext | undefined = activeInteraction(session),
  ) {
    if (!context || context.abortController.signal.aborted) return;
    try {
      await this.resolvePermission(session, data, context);
    } catch (error) {
      process.stderr.write(
        `[opencode2] Could not answer an OpenCode permission request: ${errorMessage(error)}\n`,
      );
    }
  }

  /**
   * Another OpenCode client can answer a permission before the BB user does.
   * The provider bridge cannot cancel a provider interaction, so keep the
   * settled request here and skip a stale reply when BB answers later.
   */
  handlePermissionReplied(
    session: SessionState,
    data: RecordValue,
    context: InteractionContext | undefined = activeInteraction(session),
  ) {
    const requestId = stringValue(data.requestID);
    const reply = stringValue(data.reply);
    if (
      !requestId ||
      (reply !== "once" && reply !== "always" && reply !== "reject") ||
      !context ||
      context.abortController.signal.aborted
    )
      return;
    if (context.ownPermissionReplies.delete(requestId)) return;
    context.settledPermissions.add(requestId);
  }

  /**
   * Forms answered or cancelled in another OpenCode client cannot have their
   * BB card cancelled either. Keep the result so a later BB answer reports the
   * real outcome instead of replying to an already-settled form.
   */
  handleFormEvent(
    session: SessionState,
    type: "form.replied" | "form.cancelled",
    data: RecordValue,
    context: InteractionContext | undefined = activeInteraction(session),
  ) {
    const formId = stringValue(data.id);
    if (!formId || !context || context.abortController.signal.aborted) return;
    if (context.ownForms.delete(formId)) return;
    context.settledForms.set(
      formId,
      type === "form.replied" ? "answered" : "cancelled",
    );
  }

  private async resolvePermission(
    session: SessionState,
    data: RecordValue,
    context: InteractionContext,
  ) {
    const sessionId = stringValue(data.sessionID);
    const requestId = stringValue(data.id);
    if (!sessionId || !requestId) return;
    if (context.settledPermissions.delete(requestId)) return;
    const action = stringValue(data.action) ?? "";
    const automaticReply = automaticPermissionReply(
      session.permissionMode,
      session.disableSubagents,
      action,
    );
    if (automaticReply) {
      await this.replyPermission(context, sessionId, requestId, automaticReply);
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
      const result = await this.interactions(
        "interaction/request",
        {
          providerThreadId: session.providerThreadId,
          threadId: session.bbThreadId,
          turnId: context.providerTurnId,
          payload,
        },
        { signal: context.abortController.signal },
      );
      const decision = result?.decision;
      if (context.settledPermissions.delete(requestId)) return;
      const reply = context.abortController.signal.aborted
        ? "reject"
        : approvalPermissionReply(decision);
      await this.replyPermission(context, sessionId, requestId, reply);
    } catch {
      if (context.settledPermissions.delete(requestId)) return;
      await this.replyPermission(context, sessionId, requestId, "reject").catch(
        () => {},
      );
    }
  }

  private async replyPermission(
    context: InteractionContext,
    sessionId: string,
    requestId: string,
    decision: OpenCodePermissionReply,
  ) {
    context.ownPermissionReplies.add(requestId);
    try {
      const api = await this.api();
      await api.permission.reply({
        sessionID: sessionId,
        requestID: requestId,
        ...permissionReplyBody(decision),
      });
    } catch (error) {
      context.ownPermissionReplies.delete(requestId);
      throw error;
    }
  }

  /** Route a `form.created` event to the question tool that raised it. */
  handleCreatedForm(
    session: SessionState,
    form: RecordValue,
    context: InteractionContext | undefined = activeInteraction(session),
  ) {
    if (!context || context.abortController.signal.aborted) return;
    const callId = this.questionCallId(form);
    if (callId) {
      const waiter = context.questionWaiters.get(callId);
      if (waiter) {
        context.questionWaiters.delete(callId);
        waiter.resolve(form);
        return;
      }
      if (
        !context.background &&
        inputRecord(form.metadata).kind === "question"
      ) {
        context.earlyQuestionForms.set(callId, form);
        return;
      }
    }
    const formId = stringValue(form.id);
    if (!formId) return;
    const key = `form:${formId}`;
    if (context.openQuestions.has(key) || context.settledTools.has(key)) return;
    if (!context.opened.has(key)) {
      const item = { type: "tool", tool: "question", args: {} };
      context.opened.set(key, item);
      this.emitTimeline(session.bbThreadId, [
        {
          kind: "item.open",
          key: itemKey(key, "tool"),
          item,
          ...turnId(context),
        },
      ]);
    }
    void this.answerQuestionForm(session, context, key, form).catch(() => {});
  }

  cancelQuestionWaiters(context: InteractionContext) {
    for (const waiter of context.questionWaiters.values())
      waiter.resolve(undefined);
    context.questionWaiters.clear();
    context.earlyQuestionForms.clear();
  }

  private waitForQuestionForm(
    context: InteractionContext,
    callId: string,
  ): Promise<RecordValue | undefined> {
    const early = context.earlyQuestionForms.get(callId);
    if (early) {
      context.earlyQuestionForms.delete(callId);
      return Promise.resolve(early);
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        context.questionWaiters.delete(callId);
        resolve(undefined);
      }, QUESTION_WAIT_TIMEOUT_MS);
      context.questionWaiters.set(callId, {
        resolve(form) {
          clearTimeout(timeout);
          resolve(form);
        },
      });
    });
  }

  async cancelQuestionForm(
    context: InteractionContext,
    formId: string,
    message?: string,
  ) {
    context.ownForms.add(formId);
    await this.api()
      .then((api) =>
        api.session.form.cancel({
          sessionID: context.formSessionId,
          formID: formId,
          ...(message ? { message } : {}),
        }),
      )
      .catch(() => {
        context.ownForms.delete(formId);
      });
  }

  private closeQuestion(
    session: SessionState,
    context: InteractionContext,
    callId: string,
    status: "completed" | "failed",
    text: string,
  ) {
    const item = context.opened.get(callId) ?? {
      type: "tool",
      tool: "question",
      args: {},
    };
    if (status === "completed") item.result = text;
    else item.error = text;
    context.opened.delete(callId);
    context.openQuestions.delete(callId);
    context.settledTools.add(callId);
    this.emitTimeline(session.bbThreadId, [
      {
        kind: "item.close",
        key: itemKey(callId, "tool"),
        status,
        ...(status === "completed" ? { resultText: text } : {}),
        item,
        ...turnId(context),
      },
    ]);
  }

  private closeExternalForm(
    session: SessionState,
    context: InteractionContext,
    callId: string,
    formId: string,
    result: "answered" | "cancelled",
  ) {
    context.settledForms.delete(formId);
    this.closeQuestion(
      session,
      context,
      callId,
      result === "answered" ? "completed" : "failed",
      result === "answered" ? "Answered in OpenCode" : "Cancelled in OpenCode",
    );
  }

  async handleQuestion(
    session: SessionState,
    active: ActiveTurn,
    callId: string,
  ) {
    const context = interactiveTurn(session, active);
    const form = await this.waitForQuestionForm(context, callId);
    if (session.active !== active || !context.opened.has(callId)) return;
    if (!form) {
      this.closeQuestion(
        session,
        context,
        callId,
        "failed",
        "OpenCode question went unanswered (no prompt received)",
      );
      return;
    }
    await this.answerQuestionForm(session, context, callId, form);
  }

  private async failQuestion(
    session: SessionState,
    context: InteractionContext,
    callId: string,
    formId: string,
    message: string,
    cancelMessage?: string,
  ) {
    await this.cancelQuestionForm(context, formId, cancelMessage);
    this.closeQuestion(session, context, callId, "failed", message);
  }

  private async answerQuestionForm(
    session: SessionState,
    context: InteractionContext,
    callId: string,
    form: RecordValue,
  ) {
    const formId = stringValue(form.id);
    if (!formId) {
      this.closeQuestion(
        session,
        context,
        callId,
        "failed",
        "OpenCode question did not include a form ID",
      );
      return;
    }
    context.openQuestions.set(callId, formId);
    const settled = context.settledForms.get(formId);
    if (settled) {
      this.closeExternalForm(session, context, callId, formId, settled);
      return;
    }
    const plan = planFormQuestions(form);
    if ("error" in plan) {
      await this.failQuestion(
        session,
        context,
        callId,
        formId,
        plan.error,
        plan.error,
      );
      return;
    }
    let resolution: RecordValue | undefined;
    try {
      const result = await this.interactions(
        "interaction/request",
        {
          providerThreadId: session.providerThreadId,
          threadId: session.bbThreadId,
          turnId: context.providerTurnId,
          payload: { kind: "user_question", questions: plan.questions },
        },
        { signal: context.abortController.signal },
      );
      resolution = result;
    } catch {
      resolution = undefined;
    }
    if (context.abortController.signal.aborted || !context.opened.has(callId))
      return;
    const external = context.settledForms.get(formId);
    if (external) {
      this.closeExternalForm(session, context, callId, formId, external);
      return;
    }
    const answers: RecordValue | undefined =
      resolution?.kind === "user_answer" ? resolution.answers : undefined;
    if (!answers) {
      await this.failQuestion(
        session,
        context,
        callId,
        formId,
        "Question dismissed",
      );
      return;
    }
    const mapped = answerFormFields(plan.fields, plan.hiddenAnswers, answers);
    if ("error" in mapped) {
      await this.failQuestion(
        session,
        context,
        callId,
        formId,
        mapped.error,
        mapped.error,
      );
      return;
    }
    try {
      const api = await this.api();
      context.ownForms.add(formId);
      await api.session.form.reply({
        sessionID: context.formSessionId,
        formID: formId,
        answer: mapped.answer,
      });
    } catch (error) {
      context.ownForms.delete(formId);
      const late = context.settledForms.get(formId);
      if (late) {
        this.closeExternalForm(session, context, callId, formId, late);
        return;
      }
      const message = errorMessage(error);
      await this.failQuestion(
        session,
        context,
        callId,
        formId,
        message,
        message,
      );
      return;
    }
    this.closeQuestion(
      session,
      context,
      callId,
      "completed",
      mapped.summary.join("\n"),
    );
  }
}
