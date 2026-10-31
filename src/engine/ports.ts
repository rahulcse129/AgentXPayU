/**
 * The edges of the engine. Swap implementations without touching the money logic:
 * in-process mocks for tests/sim, HTTP x402 providers and a real LLM judge for the demo.
 */
import type { Micros } from "../money.ts";
import type { PaymentRequirement, Step } from "../policy/types.ts";

export interface ProviderPort {
  /** Ask for the work; the provider answers 402 with what it wants paid. */
  requestQuote(providerId: string, step: Step, key: string): Promise<PaymentRequirement>;
  /** Present proof of payment and receive the work. */
  deliver(providerId: string, step: Step, key: string, txHash: string): Promise<{ output: string; latencyMs: number }>;
}

/**
 * The LLM's job. It scores answers (0..1) and may phrase explanations.
 * It never decides amounts, providers, holds or reserve: that is the policy module.
 */
export interface QualityJudge {
  score(step: Step, output: string): Promise<number>;
}

export type ApprovalAnswer = "approved" | "declined" | "timeout";

export interface HoldIncreaseRequest {
  jobId: string;
  customer: string;
  current: Micros;
  newTotal: Micros;
  reason: string;
}

export interface CustomerPort {
  askHoldIncrease(req: HoldIncreaseRequest): Promise<ApprovalAnswer>;
}

// ------------------------------------------------------------------ simple implementations

/** Reads the `q=0.83` tag the mock providers embed. Replace with an LLM judge for real outputs. */
export class TagJudge implements QualityJudge {
  async score(_step: Step, output: string): Promise<number> {
    const m = /q=([0-9.]+)/.exec(output);
    return m ? Number(m[1]) : 0;
  }
}

/** Answers every request with a fixed function. For tests and the simulation. */
export class ScriptedCustomers implements CustomerPort {
  readonly asked: HoldIncreaseRequest[] = [];
  constructor(private readonly answer: (req: HoldIncreaseRequest) => ApprovalAnswer) {}
  async askHoldIncrease(req: HoldIncreaseRequest) {
    this.asked.push(req);
    return this.answer(req);
  }
}

/**
 * For the dashboard: the request waits until someone clicks approve/decline,
 * or resolves as "timeout" after `timeoutMs`.
 */
export class PendingApprovals implements CustomerPort {
  private pending = new Map<string, { req: HoldIncreaseRequest; resolve: (a: ApprovalAnswer) => void }>();

  constructor(
    private readonly timeoutMs = 30_000,
    private readonly onRequest?: (req: HoldIncreaseRequest) => void,
  ) {}

  askHoldIncrease(req: HoldIncreaseRequest): Promise<ApprovalAnswer> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(req.jobId, "timeout"), this.timeoutMs);
      this.pending.set(req.jobId, {
        req,
        resolve: (a) => {
          clearTimeout(timer);
          resolve(a);
        },
      });
      this.onRequest?.(req);
    });
  }

  list(): HoldIncreaseRequest[] {
    return [...this.pending.values()].map((p) => p.req);
  }

  approve(jobId: string) {
    this.settle(jobId, "approved");
  }

  decline(jobId: string) {
    this.settle(jobId, "declined");
  }

  private settle(jobId: string, a: ApprovalAnswer) {
    const p = this.pending.get(jobId);
    if (!p) return;
    this.pending.delete(jobId);
    p.resolve(a);
  }
}
