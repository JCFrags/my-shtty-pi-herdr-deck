import type { PiControl } from "./types.js";
const validText = (value: string, max = 65_536): void => {
  if (!value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value))
    throw new Error("INVALID_REQUEST");
};
export class PiControlRouter {
  readonly #adapters = new Map<string, PiControl>();
  register(agentId: string, control: PiControl): void {
    this.#adapters.set(agentId, control);
  }
  unregister(agentId: string): void {
    this.#adapters.delete(agentId);
  }
  connected(agentId: string): boolean {
    return this.#adapters.has(agentId);
  }
  private get(agentId: string): PiControl {
    const control = this.#adapters.get(agentId);
    if (!control) throw new Error("AGENT_DISCONNECTED");
    return control;
  }
  async prompt(agentId: string, message: string): Promise<void> {
    validText(message);
    await this.get(agentId).prompt(message);
  }
  async steer(agentId: string, message: string): Promise<void> {
    validText(message);
    await this.get(agentId).steer(message);
  }
  async followUp(agentId: string, message: string): Promise<void> {
    validText(message);
    await this.get(agentId).followUp(message);
  }
  async abort(agentId: string): Promise<void> {
    await this.get(agentId).abort();
  }
  async compact(agentId: string): Promise<void> {
    await this.get(agentId).compact();
  }
  async setModel(
    agentId: string,
    provider: string,
    modelId: string,
  ): Promise<void> {
    validText(provider, 256);
    validText(modelId, 256);
    await this.get(agentId).setModel(provider, modelId);
  }
  async setThinking(agentId: string, level: string): Promise<void> {
    validText(level, 128);
    await this.get(agentId).setThinking(level);
  }
  async setTools(agentId: string, names: string[]): Promise<void> {
    if (names.length > 4096) throw new Error("LIMIT_EXCEEDED");
    await this.get(agentId).setTools(names);
  }
}
