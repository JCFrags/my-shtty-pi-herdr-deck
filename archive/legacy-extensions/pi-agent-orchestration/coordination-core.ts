export type WaitKind = "timer" | "herdr_agent";
export type WaitOutcome = "active" | "completed" | "timed_out" | "cancelled" | "superseded" | "error";
export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface HerdrAgentSessionIdentity {
	agent: string;
	kind: "id" | "path";
	source: string;
	value: string;
}

export interface HerdrTargetIdentity {
	agent: string | null;
	name: string | null;
	workspaceId: string;
	tabId: string;
	paneId: string;
	terminalId: string;
	agentSession: HerdrAgentSessionIdentity | null;
}

export interface HerdrAgentObservation {
	status: HerdrAgentStatus;
	identity?: HerdrTargetIdentity;
	revision?: number;
	stateChangeSequence?: number;
}

export type IdentityState =
	| "not_applicable"
	| "unobserved"
	| "unavailable"
	| "current"
	| "stale"
	| "unverified_after_restore";

export type ObservationFreshness = "not_applicable" | "unobserved" | "fresh" | "stale";

export interface CoordinationWaitInspectionV1 {
	schemaVersion: 1;
	capturedAt: number;
	wait: WaitRecord;
	diagnostics: {
		scope: "runtime";
		restoredFromV1: boolean;
		target: {
			requestedName: string;
			identityState: IdentityState;
			baseline: HerdrTargetIdentity | null;
			current: HerdrTargetIdentity | null;
			changedAt: number | null;
		} | null;
		observation: {
			status: HerdrAgentStatus | null;
			observedAt: number | null;
			ageMs: number | null;
			freshForMs: number | null;
			freshness: ObservationFreshness;
			revision: number | null;
			stateChangeSequence: number | null;
		};
		polling: {
			inFlight: boolean;
			lastSuccessAt: number | null;
			lastError: {
				message: string;
				at: number;
				resolved: boolean;
			} | null;
		} | null;
	};
}

export interface WaitRecord {
	version: 1;
	id: string;
	kind: WaitKind;
	state: WaitOutcome;
	createdAt: number;
	updatedAt: number;
	deadline: number;
	target?: string;
	desiredStatuses?: HerdrAgentStatus[];
	pollMs?: number;
	wakeSent: boolean;
	reason?: string;
}

export interface SafeWake {
	id: string;
	kind: WaitKind;
	outcome: Exclude<WaitOutcome, "active">;
	finishedAt: number;
	condition: string;
}

export interface Clock {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface CoordinatorHooks {
	clock: Clock;
	getHerdrAgentStatus(
		target: string,
		signal: AbortSignal,
	): Promise<HerdrAgentStatus | HerdrAgentObservation>;
	persist(record: WaitRecord): void;
	wake(event: SafeWake): void;
	onChange?(): void;
	wakeDebounceMs?: number;
}

interface RuntimeWait {
	record: WaitRecord;
	generation: number;
	restoredFromV1: boolean;
	handle?: unknown;
	wakeHandle?: unknown;
	pollController?: AbortController;
	pollInFlight: boolean;
	observation?: HerdrAgentObservation & { observedAt: number };
	baselineIdentity?: HerdrTargetIdentity;
	currentIdentity?: HerdrTargetIdentity;
	identityChangedAt?: number;
	lastPollSuccessAt?: number;
	lastPollError?: { message: string; at: number; resolved: boolean };
}

const MAX_DELAY_MS = 2_147_000_000;
const DEFAULT_WAKE_DEBOUNCE_MS = 100;
const MIN_OBSERVATION_FRESH_MS = 3_000;
const MAX_POLL_ERROR_CHARS = 512;

export class RestartableSubscription<T> {
	private readonly subscribe: (handler: (data: T) => void) => () => void;
	private unsubscribe: (() => void) | undefined;

	constructor(subscribe: (handler: (data: T) => void) => () => void) {
		this.subscribe = subscribe;
	}

	start(handler: (data: T) => void): void {
		this.stop();
		this.unsubscribe = this.subscribe(handler);
	}

	stop(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}
}

function cloneRecord(record: WaitRecord): WaitRecord {
	return {
		...record,
		desiredStatuses: record.desiredStatuses ? [...record.desiredStatuses] : undefined,
	};
}

function cloneIdentity(identity: HerdrTargetIdentity): HerdrTargetIdentity {
	return {
		...identity,
		agentSession: identity.agentSession ? { ...identity.agentSession } : null,
	};
}

function identityKey(identity: HerdrTargetIdentity): string {
	return JSON.stringify([
		identity.agent,
		identity.name,
		identity.workspaceId,
		identity.tabId,
		identity.paneId,
		identity.terminalId,
		identity.agentSession?.agent ?? null,
		identity.agentSession?.kind ?? null,
		identity.agentSession?.source ?? null,
		identity.agentSession?.value ?? null,
	]);
}

function boundedErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_POLL_ERROR_CHARS);
}

function safeDelay(value: number): number {
	return Math.max(0, Math.min(MAX_DELAY_MS, value));
}

export function isValidHerdrTarget(target: string): boolean {
	return /^[a-z][a-z0-9_-]{0,31}$/.test(target);
}

export class WaitCoordinator {
	private readonly waits = new Map<string, RuntimeWait>();
	private readonly hooks: CoordinatorHooks;
	private sequence = 0;
	private generation = 0;
	private stopped = false;

	constructor(hooks: CoordinatorHooks) {
		this.hooks = hooks;
	}

	startTimer(delayMs: number): WaitRecord {
		if (!Number.isFinite(delayMs) || delayMs < 1) throw new Error("Timer duration must be at least 1 ms.");
		this.ensureRunning();
		const now = this.hooks.clock.now();
		const record: WaitRecord = {
			version: 1,
			id: this.nextId(now),
			kind: "timer",
			state: "active",
			createdAt: now,
			updatedAt: now,
			deadline: now + delayMs,
			wakeSent: false,
		};
		this.add(record, true, false);
		return cloneRecord(record);
	}

	startHerdrAgent(
		target: string,
		desiredStatuses: HerdrAgentStatus[],
		timeoutMs: number,
		pollMs: number,
	): WaitRecord {
		this.ensureRunning();
		if (!isValidHerdrTarget(target)) throw new Error("Herdr target must be a valid agent name.");
		if (desiredStatuses.length === 0) throw new Error("At least one Herdr status is required.");
		if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("Timeout must be at least 1 ms.");
		if (!Number.isFinite(pollMs) || pollMs < 50) throw new Error("Poll interval must be at least 50 ms.");
		const now = this.hooks.clock.now();
		const record: WaitRecord = {
			version: 1,
			id: this.nextId(now),
			kind: "herdr_agent",
			state: "active",
			createdAt: now,
			updatedAt: now,
			deadline: now + timeoutMs,
			target,
			desiredStatuses: [...new Set(desiredStatuses)],
			pollMs,
			wakeSent: false,
		};
		this.add(record, true, false);
		return cloneRecord(record);
	}

	restore(records: WaitRecord[]): void {
		this.ensureRunning();
		const latest = new Map<string, WaitRecord>();
		for (const record of records) {
			if (!this.isValidRecord(record)) continue;
			latest.set(record.id, cloneRecord(record));
		}
		for (const record of latest.values()) {
			this.add(record, false, true);
		}
	}

	signal(id: string, reason = "Completed by a manual wake signal."): WaitRecord | undefined {
		const runtime = this.waits.get(id);
		if (!runtime || runtime.record.state !== "active") return undefined;
		this.finish(runtime, "completed", reason, true);
		return cloneRecord(runtime.record);
	}

	cancel(id: string, reason = "Cancelled by request."): WaitRecord | undefined {
		const runtime = this.waits.get(id);
		if (!runtime || !this.isInterruptible(runtime.record)) return undefined;
		this.finish(runtime, "cancelled", reason, false);
		return cloneRecord(runtime.record);
	}

	cancelAll(reason = "Cancelled by request."): WaitRecord[] {
		const changed: WaitRecord[] = [];
		for (const runtime of this.waits.values()) {
			if (!this.isInterruptible(runtime.record)) continue;
			this.finish(runtime, "cancelled", reason, false);
			changed.push(cloneRecord(runtime.record));
		}
		return changed;
	}

	supersedeAll(reason = "Superseded by a new user instruction."): WaitRecord[] {
		const changed: WaitRecord[] = [];
		for (const runtime of this.waits.values()) {
			if (!this.isInterruptible(runtime.record)) continue;
			this.finish(runtime, "superseded", reason, false);
			changed.push(cloneRecord(runtime.record));
		}
		return changed;
	}

	get(id: string): WaitRecord | undefined {
		const record = this.waits.get(id)?.record;
		return record ? cloneRecord(record) : undefined;
	}

	inspect(id: string): CoordinationWaitInspectionV1 | undefined {
		const runtime = this.waits.get(id);
		if (!runtime) return undefined;
		const capturedAt = this.hooks.clock.now();
		const wait = cloneRecord(runtime.record);
		if (wait.kind === "timer") {
			return {
				schemaVersion: 1,
				capturedAt,
				wait,
				diagnostics: {
					scope: "runtime",
					restoredFromV1: runtime.restoredFromV1,
					target: null,
					observation: {
						status: null,
						observedAt: null,
						ageMs: null,
						freshForMs: null,
						freshness: "not_applicable",
						revision: null,
						stateChangeSequence: null,
					},
					polling: null,
				},
			};
		}

		const observedAt = runtime.observation?.observedAt ?? null;
		const freshForMs = Math.max(MIN_OBSERVATION_FRESH_MS, 2 * wait.pollMs!);
		const ageMs = observedAt === null ? null : Math.max(0, capturedAt - observedAt);
		const freshness: ObservationFreshness = ageMs === null
			? "unobserved"
			: ageMs <= freshForMs ? "fresh" : "stale";
		const identityState: IdentityState = runtime.identityChangedAt !== undefined
			? "stale"
			: !runtime.observation
				? "unobserved"
				: !runtime.currentIdentity
					? "unavailable"
					: runtime.restoredFromV1 ? "unverified_after_restore" : "current";

		return {
			schemaVersion: 1,
			capturedAt,
			wait,
			diagnostics: {
				scope: "runtime",
				restoredFromV1: runtime.restoredFromV1,
				target: {
					requestedName: wait.target!,
					identityState,
					baseline: runtime.baselineIdentity ? cloneIdentity(runtime.baselineIdentity) : null,
					current: runtime.currentIdentity ? cloneIdentity(runtime.currentIdentity) : null,
					changedAt: runtime.identityChangedAt ?? null,
				},
				observation: {
					status: runtime.observation?.status ?? null,
					observedAt,
					ageMs,
					freshForMs,
					freshness,
					revision: runtime.observation?.revision ?? null,
					stateChangeSequence: runtime.observation?.stateChangeSequence ?? null,
				},
				polling: {
					inFlight: runtime.pollInFlight,
					lastSuccessAt: runtime.lastPollSuccessAt ?? null,
					lastError: runtime.lastPollError ? { ...runtime.lastPollError } : null,
				},
			},
		};
	}

	list(): WaitRecord[] {
		return [...this.waits.values()]
			.map((runtime) => cloneRecord(runtime.record))
			.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	}

	activeCount(): number {
		let count = 0;
		for (const runtime of this.waits.values()) if (this.isInterruptible(runtime.record)) count += 1;
		return count;
	}

	shutdown(reason: "reload" | "quit" | "new" | "resume" | "fork" | string): void {
		if (this.stopped) return;
		if (reason === "reload") {
			for (const runtime of this.waits.values()) this.clearRuntime(runtime);
		} else {
			this.cancelAll(`Cancelled during Pi session shutdown (${reason}).`);
			for (const runtime of this.waits.values()) this.clearRuntime(runtime);
		}
		this.stopped = true;
		this.changed();
	}

	private ensureRunning(): void {
		if (this.stopped) throw new Error("Wait coordinator is shut down.");
	}

	private nextId(now: number): string {
		this.sequence += 1;
		return `wait-${now.toString(36)}-${this.sequence.toString(36)}`;
	}

	private add(record: WaitRecord, persist: boolean, restoredFromV1: boolean): void {
		const runtime: RuntimeWait = {
			record,
			generation: ++this.generation,
			restoredFromV1,
			pollInFlight: false,
		};
		this.waits.set(record.id, runtime);
		if (persist) this.persist(record);
		if (record.state === "active") this.arm(runtime);
		else if (!record.wakeSent && (record.state === "completed" || record.state === "timed_out" || record.state === "error")) {
			this.scheduleWake(runtime);
		}
		this.changed();
	}

	private arm(runtime: RuntimeWait): void {
		if (runtime.record.kind === "timer") {
			const remaining = runtime.record.deadline - this.hooks.clock.now();
			runtime.handle = this.hooks.clock.setTimeout(
				() => this.finishIfCurrent(runtime, "completed", "Timer completed."),
				safeDelay(remaining),
			);
			return;
		}
		runtime.handle = this.hooks.clock.setTimeout(() => void this.pollHerdr(runtime), 0);
	}

	private async pollHerdr(runtime: RuntimeWait): Promise<void> {
		if (!this.current(runtime) || runtime.record.state !== "active") return;
		if (this.hooks.clock.now() >= runtime.record.deadline) {
			this.finish(runtime, "timed_out", "Herdr condition timed out.", true);
			return;
		}
		const pollController = new AbortController();
		runtime.pollController = pollController;
		runtime.pollInFlight = true;
		try {
			const result = await this.hooks.getHerdrAgentStatus(runtime.record.target!, pollController.signal);
			if (!this.current(runtime) || runtime.record.state !== "active") return;
			const observation: HerdrAgentObservation = typeof result === "string" ? { status: result } : result;
			const observedAt = this.hooks.clock.now();
			runtime.observation = {
				...observation,
				identity: observation.identity ? cloneIdentity(observation.identity) : undefined,
				observedAt,
			};
			runtime.lastPollSuccessAt = observedAt;
			if (runtime.lastPollError) runtime.lastPollError.resolved = observedAt > runtime.lastPollError.at;
			runtime.currentIdentity = observation.identity ? cloneIdentity(observation.identity) : undefined;
			if (observation.identity) {
				if (!runtime.baselineIdentity) {
					runtime.baselineIdentity = cloneIdentity(observation.identity);
				} else if (
					runtime.identityChangedAt === undefined
					&& identityKey(runtime.baselineIdentity) !== identityKey(observation.identity)
				) {
					runtime.identityChangedAt = observedAt;
				}
			}
			if (runtime.record.desiredStatuses!.includes(observation.status)) {
				this.finish(runtime, "completed", `Herdr agent reached ${observation.status}.`, true);
				return;
			}
		} catch (error) {
			runtime.lastPollError = {
				message: boundedErrorMessage(error),
				at: this.hooks.clock.now(),
				resolved: false,
			};
		} finally {
			runtime.pollInFlight = false;
			if (runtime.pollController === pollController) runtime.pollController = undefined;
		}
		if (!this.current(runtime) || runtime.record.state !== "active") return;
		const remaining = runtime.record.deadline - this.hooks.clock.now();
		if (remaining <= 0) {
			this.finish(runtime, "timed_out", "Herdr condition timed out.", true);
			return;
		}
		runtime.handle = this.hooks.clock.setTimeout(
			() => void this.pollHerdr(runtime),
			safeDelay(Math.min(runtime.record.pollMs!, remaining)),
		);
	}

	private finishIfCurrent(
		runtime: RuntimeWait,
		outcome: Exclude<WaitOutcome, "active">,
		reason: string,
	): void {
		if (!this.current(runtime) || runtime.record.state !== "active") return;
		this.finish(runtime, outcome, reason, true);
	}

	private finish(
		runtime: RuntimeWait,
		outcome: Exclude<WaitOutcome, "active">,
		reason: string,
		shouldWake: boolean,
	): void {
		this.clearRuntime(runtime);
		runtime.generation = ++this.generation;
		runtime.record.state = outcome;
		runtime.record.updatedAt = this.hooks.clock.now();
		runtime.record.reason = reason;
		runtime.record.wakeSent = !shouldWake;
		this.persist(runtime.record);
		if (shouldWake) this.scheduleWake(runtime);
		this.changed();
	}

	private scheduleWake(runtime: RuntimeWait): void {
		const generation = runtime.generation;
		runtime.wakeHandle = this.hooks.clock.setTimeout(() => {
			if (!this.current(runtime) || runtime.generation !== generation || runtime.record.wakeSent) return;
			if (runtime.record.state === "active" || runtime.record.state === "cancelled" || runtime.record.state === "superseded") return;
			runtime.wakeHandle = undefined;
			runtime.record.wakeSent = true;
			runtime.record.updatedAt = this.hooks.clock.now();
			this.persist(runtime.record);
			this.hooks.wake({
				id: runtime.record.id,
				kind: runtime.record.kind,
				outcome: runtime.record.state,
				finishedAt: runtime.record.updatedAt,
				condition: this.conditionSummary(runtime.record),
			});
			this.changed();
		}, this.hooks.wakeDebounceMs ?? DEFAULT_WAKE_DEBOUNCE_MS);
	}

	private conditionSummary(record: WaitRecord): string {
		if (record.kind === "timer") return "timer";
		return `Herdr agent ${record.target} reached ${record.desiredStatuses?.join(" or ")}`;
	}

	private current(runtime: RuntimeWait): boolean {
		return this.waits.get(runtime.record.id) === runtime && !this.stopped;
	}

	private clearRuntime(runtime: RuntimeWait): void {
		if (runtime.handle !== undefined) this.hooks.clock.clearTimeout(runtime.handle);
		if (runtime.wakeHandle !== undefined) this.hooks.clock.clearTimeout(runtime.wakeHandle);
		runtime.pollController?.abort();
		runtime.handle = undefined;
		runtime.wakeHandle = undefined;
		runtime.pollController = undefined;
		runtime.pollInFlight = false;
	}

	private isInterruptible(record: WaitRecord): boolean {
		return record.state === "active" || !record.wakeSent;
	}

	private persist(record: WaitRecord): void {
		this.hooks.persist(cloneRecord(record));
	}

	private changed(): void {
		this.hooks.onChange?.();
	}

	private isValidRecord(value: WaitRecord): boolean {
		if (!value || value.version !== 1 || typeof value.id !== "string") return false;
		if (value.kind !== "timer" && value.kind !== "herdr_agent") return false;
		if (!Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt) || !Number.isFinite(value.deadline)) return false;
		if (typeof value.wakeSent !== "boolean") return false;
		if (value.kind === "herdr_agent") {
			return typeof value.target === "string" && Array.isArray(value.desiredStatuses) && Number.isFinite(value.pollMs);
		}
		return true;
	}
}

export const systemClock: Clock = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => {
		const handle = setTimeout(callback, delayMs);
		handle.unref?.();
		return handle;
	},
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
