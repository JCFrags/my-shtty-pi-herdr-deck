import { createId } from "../shared/ids.js";
import { OrchestratorError } from "../shared/errors.js";
import { canonicalJson } from "../shared/canonical-json.js";
import type {
  EvidenceSummary,
  QuestionBody,
  QuestionRecord,
  ResultBody,
  ResultEnvelope,
  ResultEvent,
  RunBinding,
} from "./types.js";
import { payloadHash, validateQuestion, validateResult } from "./validation.js";
import type { GitEvidence } from "../git/porcelain.js";
export interface ResultServiceOptions {
  now?: () => Date;
  emit?: (event: ResultEvent) => Promise<void>;
  recover?: (run: RunBinding) => Promise<void>;
  evidence?: (run: RunBinding) => Promise<GitEvidence | undefined>;
}
export class ResultService {
  readonly runs = new Map<string, RunBinding>();
  readonly results = new Map<string, ResultEnvelope>();
  readonly events: ResultEvent[] = [];
  #questions = new Map<string, QuestionRecord>();
  #waiters = new Map<string, (answer: QuestionRecord) => void>();
  readonly #now: () => Date;
  readonly #emit?: ResultServiceOptions["emit"];
  readonly #recover?: ResultServiceOptions["recover"];
  readonly #evidence?: ResultServiceOptions["evidence"];
  constructor(options: ResultServiceOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#emit = options.emit;
    this.#recover = options.recover;
    this.#evidence = options.evidence;
  }
  async registerRun(run: RunBinding): Promise<void> {
    if (this.runs.has(run.runId))
      throw new OrchestratorError("RUN_MISMATCH", "Run already exists.");
    this.runs.set(run.runId, { ...run });
  }
  async publish(input: {
    runId: string;
    taskId: string;
    agentId: string;
    assignmentGeneration: number;
    body: unknown;
  }): Promise<{ resultId: string; state: string }> {
    const run = this.requireRun(input);
    validateResult(input.body);
    const body = input.body as ResultBody;
    const prior = [...this.results.values()].find((r) => r.runId === run.runId);
    if (prior) {
      if (prior.payloadHash === payloadHash(body))
        return { resultId: prior.id, state: "already_published" };
      throw new OrchestratorError(
        "RESULT_ALREADY_PUBLISHED",
        "A different terminal result is already published.",
      );
    }
    const evidence = await this.#evidence?.(run);
    const validation = this.evidenceStatus(body, evidence);
    const result: ResultEnvelope = {
      ...body,
      id: createId("res"),
      taskId: run.taskId,
      runId: run.runId,
      agentId: run.agentId,
      assignmentGeneration: run.assignmentGeneration,
      publishedAt: this.#now().toISOString(),
      payloadHash: payloadHash(body),
      validation: {
        schemaValid: true,
        correlationValid: true,
        piSettled: run.piSettled,
        ...validation,
      },
    };
    this.results.set(result.id, result);
    run.state =
      run.piSettled && !run.terminalError ? "succeeded" : "result_pending";
    run.resultId = result.id;
    await this.emit({
      type: "result.published",
      refs: {
        resultId: result.id,
        runId: run.runId,
        taskId: run.taskId,
        agentId: run.agentId,
      },
      payload: { resultId: result.id, payloadHash: result.payloadHash },
    });
    await this.emit({
      type: "result.validated",
      refs: { resultId: result.id, runId: run.runId },
      payload: result.validation,
    });
    return { resultId: result.id, state: run.state };
  }
  async settle(
    runId: string,
    terminalError = false,
  ): Promise<{ state: string }> {
    const existing = this.runs.get(runId);
    if (
      existing &&
      ["failed", "cancelled", "timed_out", "lost"].includes(existing.state)
    )
      return { state: existing.state };
    const run = this.requireRun({ runId });
    run.piSettled = true;
    run.terminalError = terminalError;
    const result = [...this.results.values()].find((r) => r.runId === runId);
    if (!result) {
      run.state =
        run.resultRecoveryCount === 0 ? "result_pending_missing" : "failed";
      if (run.resultRecoveryCount === 0) {
        run.resultRecoveryCount = 1;
        await this.emit({
          type: "run.result_recovery_requested",
          refs: { runId: run.runId, taskId: run.taskId, agentId: run.agentId },
          payload: { attempt: 1 },
        });
        await this.#recover?.(run);
      }
      return { state: run.state };
    }
    result.validation.piSettled = true;
    run.state = terminalError ? "failed" : "succeeded";
    await this.emit({
      type: "run.pi_settled",
      refs: { runId },
      payload: { terminalError, resultId: result.id },
    });
    return { state: run.state };
  }
  async failMissing(runId: string): Promise<void> {
    const run = this.requireRun({ runId });
    if (run.state !== "result_pending_missing")
      throw new OrchestratorError(
        "RESULT_MISSING",
        "Run is not waiting for result recovery.",
      );
    run.state = "failed";
    await this.emit({
      type: "run.result_missing",
      refs: { runId, taskId: run.taskId },
      payload: { code: "RESULT_MISSING" },
    });
  }
  getResult(id: string): ResultEnvelope {
    const result = this.results.get(id);
    if (!result)
      throw new OrchestratorError("NOT_FOUND", "Result was not found.");
    return structuredClone(result);
  }
  private requireRun(
    input: Partial<RunBinding> & { runId: string },
  ): RunBinding {
    const run = this.runs.get(input.runId);
    if (
      !run ||
      (input.taskId !== undefined && run.taskId !== input.taskId) ||
      (input.agentId !== undefined && run.agentId !== input.agentId) ||
      (input.assignmentGeneration !== undefined &&
        run.assignmentGeneration !== input.assignmentGeneration)
    )
      throw new OrchestratorError(
        "RUN_MISMATCH",
        "Run identity or assignment generation does not match.",
      );
    if (
      ["succeeded", "failed", "cancelled", "timed_out", "lost"].includes(
        run.state,
      )
    )
      throw new OrchestratorError("RUN_MISMATCH", "Run is terminal.");
    return run;
  }
  private evidenceStatus(
    body: ResultBody,
    evidence: GitEvidence | undefined,
  ): EvidenceSummary {
    const testEvidenceStatus = body.tests.length
      ? ("reported" as const)
      : ("not_reported" as const);
    if (!evidence)
      return { gitEvidenceStatus: "not_applicable", testEvidenceStatus };
    const claimed = new Set(body.changedFiles.map((f) => f.path));
    const actual = new Set(evidence.changedFiles);
    const contradiction =
      [...claimed].some((p) => !actual.has(p)) ||
      [...actual].some((p) => !claimed.has(p));
    return {
      gitEvidenceStatus: contradiction ? "contradiction" : "consistent",
      testEvidenceStatus,
      git: evidence,
    };
  }
  private async emit(event: ResultEvent): Promise<void> {
    this.events.push(structuredClone(event));
    await this.#emit?.(event);
  }
  async ask(input: {
    runId: string;
    taskId: string;
    agentId: string;
    assignmentGeneration: number;
    body: unknown;
  }): Promise<QuestionRecord> {
    const run = this.requireRun(input);
    if (run.state !== "working")
      throw new OrchestratorError(
        "RUN_MISMATCH",
        "Only a working run can ask a question.",
      );
    if (
      [...this.#questions.values()].some(
        (q) => q.runId === run.runId && q.state === "open",
      )
    )
      throw new OrchestratorError(
        "LIMIT_EXCEEDED",
        "A run may have only one open question.",
      );
    validateQuestion(input.body);
    const body = input.body as QuestionBody;
    const q: QuestionRecord = {
      ...body,
      id: createId("qst"),
      taskId: run.taskId,
      runId: run.runId,
      agentId: run.agentId,
      assignmentGeneration: run.assignmentGeneration,
      state: "open",
      askedAt: this.#now().toISOString(),
    };
    this.#questions.set(q.id, q);
    run.state = "blocked";
    await this.emit({
      type: "question.opened",
      refs: {
        questionId: q.id,
        runId: run.runId,
        taskId: run.taskId,
        agentId: run.agentId,
      },
      payload: {
        questionId: q.id,
        deadline: new Date(this.#now().getTime() + q.timeoutMs).toISOString(),
      },
    });
    return structuredClone(q);
  }
  async answer(
    questionId: string,
    answer: { optionId?: string; text?: string },
    principalId: string,
  ): Promise<QuestionRecord> {
    const q = this.#questions.get(questionId);
    if (!q)
      throw new OrchestratorError(
        "QUESTION_NOT_FOUND",
        "Question was not found.",
      );
    if (q.state !== "open")
      throw new OrchestratorError(
        "QUESTION_ALREADY_ANSWERED",
        "Question is already terminal.",
        { details: { state: q.state, questionId } },
      );
    if (
      answer.optionId !== undefined &&
      !q.options.some((o) => o.id === answer.optionId)
    )
      throw new OrchestratorError(
        "INVALID_REQUEST",
        "Answer option is not present.",
      );
    if (
      answer.optionId === undefined &&
      (!q.allowFreeform || !answer.text || answer.text.length > 16384)
    )
      throw new OrchestratorError(
        "INVALID_REQUEST",
        "Free-form answer is not allowed or is invalid.",
      );
    q.state = "answered";
    q.answeredAt = this.#now().toISOString();
    q.answeredBy = principalId;
    q.answer = {
      ...(answer.optionId ? { optionId: answer.optionId } : {}),
      ...(answer.text ? { text: answer.text } : {}),
    };
    const run = this.runs.get(q.runId);
    if (run?.state === "blocked") run.state = "working";
    await this.emit({
      type: "question.answered",
      refs: { questionId, runId: q.runId, taskId: q.taskId },
      payload: { questionId, answeredBy: principalId },
    });
    const waiter = this.#waiters.get(questionId);
    if (waiter) {
      this.#waiters.delete(questionId);
      waiter(q);
    }
    return structuredClone(q);
  }
  async timeout(questionId: string): Promise<void> {
    const q = this.#questions.get(questionId);
    if (!q || q.state !== "open") return;
    q.state = "timed_out";
    const run = this.runs.get(q.runId);
    if (run && run.state === "blocked") run.state = "failed";
    await this.emit({
      type: "question.timed_out",
      refs: { questionId, runId: q.runId, taskId: q.taskId },
      payload: { questionId },
    });
  }
  getQuestion(id: string): QuestionRecord {
    const q = this.#questions.get(id);
    if (!q)
      throw new OrchestratorError(
        "QUESTION_NOT_FOUND",
        "Question was not found.",
      );
    return structuredClone(q);
  }
  waitForAnswer(id: string, timeoutMs: number): Promise<QuestionRecord> {
    const q = this.getQuestion(id);
    if (q.state !== "open") return Promise.resolve(q);
    return new Promise((resolve) => {
      this.#waiters.set(id, resolve);
      const timer = setTimeout(() => {
        this.#waiters.delete(id);
        void this.timeout(id).then(() => resolve(this.getQuestion(id)));
      }, timeoutMs);
      timer.unref?.();
    });
  }
}
export function resultCanonicalJson(result: ResultEnvelope): string {
  return canonicalJson(result);
}
