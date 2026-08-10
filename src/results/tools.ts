import type { QuestionBody, ResultBody, RunBinding } from "./types.js";
import { ResultService } from "./service.js";
export interface ManagedToolContext { run: RunBinding; principalId: string; }
export class ManagedChildTools {
  constructor(private readonly service: ResultService) {}
  async orchestratorResult(context: ManagedToolContext, body: ResultBody): Promise<{ resultId: string; state: string }> {
    return this.service.publish({ runId: context.run.runId, taskId: context.run.taskId, agentId: context.run.agentId, assignmentGeneration: context.run.assignmentGeneration, body });
  }
  async orchestratorAsk(context: ManagedToolContext, body: QuestionBody): Promise<{ questionId: string; answer?: { optionId?: string; text?: string }; state: string }> {
    const question = await this.service.ask({ runId: context.run.runId, taskId: context.run.taskId, agentId: context.run.agentId, assignmentGeneration: context.run.assignmentGeneration, body });
    const answered = await this.service.waitForAnswer(question.id, body.timeoutMs);
    return { questionId: answered.id, ...(answered.answer ? { answer: answered.answer } : {}), state: answered.state };
  }
}
export class ParentResultTools {
  constructor(private readonly service: ResultService) {}
  getResult(context: ManagedToolContext, resultId: string) { const result = this.service.getResult(resultId); return result.taskId === context.run.taskId || result.agentId === context.run.agentId ? result : undefined; }
  answer(context: ManagedToolContext, questionId: string, answer: { optionId?: string; text?: string }) { return this.service.answer(questionId, answer, context.principalId); }
}
