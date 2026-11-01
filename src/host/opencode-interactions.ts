import {
  experimental_presentationDetail as presentationDetail,
  experimental_presentationTitle as presentationTitle,
  USER_QUESTION_MAX_OPTIONS,
  USER_QUESTION_MAX_QUESTIONS,
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
  private readonly settledForms = new Map<string, "answered" | "cancelled">();
  private readonly ownFormReplies = new Set<string>();
  private readonly ownFormCancels = new Set<string>();
  private readonly settledPermissions = new Map<
    string,
    OpenCodePermissionReply
  >();
  private readonly ownPermissionReplies = new Set<string>();
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

  private sessionKey(sessionId: string, id: string) {
    return `${sessionId}:${id}`;
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

  /**
   * Another OpenCode client can answer a permission before the BB user does.
   * The provider bridge cannot cancel a provider interaction, so keep the
   * settled request here and skip a stale reply when BB answers later.
   */
  handlePermissionReplied(session: SessionState, data: RecordValue) {
    const requestId = stringValue(data.requestID);
    const reply = stringValue(data.reply);
    if (
      !requestId ||
      (reply !== "once" && reply !== "always" && reply !== "reject")
    )
      return;
    const key = this.sessionKey(session.providerThreadId, requestId);
    if (this.ownPermissionReplies.delete(key)) return;
    const active = session.active;
    if (!active || active.finishing) return;
    this.settledPermissions.set(key, reply);
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
  ) {
    const formId = stringValue(data.id);
    if (!formId) return;
    const key = this.sessionKey(session.providerThreadId, formId);
    if (type === "form.replied") {
      if (this.ownFormReplies.delete(key)) return;
      const active = session.active;
      if (!active || active.finishing) return;
      this.settledForms.set(key, "answered");
      return;
    }
    if (this.ownFormCancels.delete(key)) return;
    const active = session.active;
    if (!active || active.finishing) return;
    this.settledForms.set(key, "cancelled");
  }

  private async resolvePermission(session: SessionState, data: RecordValue) {
    const active = session.active;
    if (!active) return;
    const sessionId = stringValue(data.sessionID);
    const requestId = stringValue(data.id);
    if (!sessionId || !requestId) return;
    const permissionKey = this.sessionKey(sessionId, requestId);
    if (this.settledPermissions.delete(permissionKey)) return;
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
      const result = await this.interactions(
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
      if (this.settledPermissions.delete(permissionKey)) return;
      const reply =
        session.active === active
          ? approvalPermissionReply(decision)
          : "reject";
      await this.replyPermission(sessionId, requestId, reply);
    } catch {
      if (this.settledPermissions.delete(permissionKey)) return;
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
    const key = this.sessionKey(sessionId, requestId);
    this.ownPermissionReplies.add(key);
    try {
      const api = await this.api();
      await api.permission.reply({
        sessionID: sessionId,
        requestID: requestId,
        ...permissionReplyBody(decision),
      });
    } catch (error) {
      this.ownPermissionReplies.delete(key);
      throw error;
    }
  }

  /** Route a `form.created` event to the question tool that raised it. */
  handleCreatedForm(session: SessionState, form: RecordValue) {
    const callId = this.questionCallId(form);
    if (callId) {
      const key = this.sessionKey(session.providerThreadId, callId);
      const waiter = this.questionWaiters.get(key);
      if (waiter) {
        this.questionWaiters.delete(key);
        waiter.resolve(form);
        return;
      }
      if (inputRecord(form.metadata).kind === "question") {
        this.earlyQuestionForms.set(key, form);
        return;
      }
    }
    const active = session.active;
    const formId = stringValue(form.id);
    if (!active || !formId) return;
    const key = `form:${formId}`;
    if (active.openQuestions.has(key) || active.settledTools.has(key)) return;
    if (!active.opened.has(key)) {
      const item = { type: "tool", tool: "question", args: {} };
      active.opened.set(key, item);
      this.emitTimeline(session.bbThreadId, [
        {
          kind: "item.open",
          key: itemKey(key, "tool"),
          item,
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    void this.answerQuestionForm(session, active, key, form).catch(() => {});
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
    for (const key of [...this.settledForms.keys()])
      if (key.startsWith(prefix)) this.settledForms.delete(key);
    for (const key of [...this.settledPermissions.keys()])
      if (key.startsWith(prefix)) this.settledPermissions.delete(key);
    for (const set of [
      this.ownFormReplies,
      this.ownFormCancels,
      this.ownPermissionReplies,
    ])
      for (const key of [...set]) if (key.startsWith(prefix)) set.delete(key);
  }

  private waitForQuestionForm(
    session: SessionState,
    active: ActiveTurn,
    callId: string,
  ): Promise<RecordValue | undefined> {
    const key = this.sessionKey(session.providerThreadId, callId);
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

  async cancelQuestionForm(
    session: SessionState,
    formId: string,
    message?: string,
  ) {
    const key = this.sessionKey(session.providerThreadId, formId);
    this.ownFormCancels.add(key);
    await this.api()
      .then((api) =>
        api.session.form.cancel({
          sessionID: session.providerThreadId,
          formID: formId,
          ...(message ? { message } : {}),
        }),
      )
      .catch(() => {
        this.ownFormCancels.delete(key);
      });
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

  private closeExternalForm(
    session: SessionState,
    active: ActiveTurn,
    callId: string,
    formId: string,
    result: "answered" | "cancelled",
  ) {
    this.settledForms.delete(this.sessionKey(session.providerThreadId, formId));
    this.closeQuestion(
      session,
      active,
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

  private async failQuestion(
    session: SessionState,
    active: ActiveTurn,
    callId: string,
    formId: string,
    message: string,
    cancelMessage?: string,
  ) {
    await this.cancelQuestionForm(session, formId, cancelMessage);
    this.closeQuestion(session, active, callId, "failed", message);
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
    const formKey = this.sessionKey(session.providerThreadId, formId);
    const settled = this.settledForms.get(formKey);
    if (settled) {
      this.closeExternalForm(session, active, callId, formId, settled);
      return;
    }
    const plan = planFormQuestions(form);
    if ("error" in plan) {
      await this.failQuestion(
        session,
        active,
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
          turnId: active.providerTurnId,
          payload: { kind: "user_question", questions: plan.questions },
        },
        { signal: active.abortController.signal },
      );
      resolution = result?.resolution;
    } catch {
      resolution = undefined;
    }
    if (session.active !== active || !active.opened.has(callId)) return;
    const external = this.settledForms.get(formKey);
    if (external) {
      this.closeExternalForm(session, active, callId, formId, external);
      return;
    }
    const answers: RecordValue | undefined =
      resolution?.kind === "user_answer" ? resolution.answers : undefined;
    if (!answers) {
      await this.failQuestion(
        session,
        active,
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
        active,
        callId,
        formId,
        mapped.error,
        mapped.error,
      );
      return;
    }
    try {
      const api = await this.api();
      this.ownFormReplies.add(formKey);
      await api.session.form.reply({
        sessionID: session.providerThreadId,
        formID: formId,
        answer: mapped.answer,
      });
    } catch (error) {
      this.ownFormReplies.delete(formKey);
      const late = this.settledForms.get(formKey);
      if (late) {
        this.closeExternalForm(session, active, callId, formId, late);
        return;
      }
      const message = errorMessage(error);
      await this.failQuestion(
        session,
        active,
        callId,
        formId,
        message,
        message,
      );
      return;
    }
    this.closeQuestion(
      session,
      active,
      callId,
      "completed",
      mapped.summary.join("\n"),
    );
  }
}
