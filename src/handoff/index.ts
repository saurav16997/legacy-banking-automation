import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const DEFAULT_HANDOFF_TTL_MS = 10 * 60 * 1_000;

export type HandoffDisposition = "ACTIVE" | "CONSUMED" | "ABANDONED" | "EXPIRED";

export interface HandoffBinding {
  readonly runId: string;
  readonly artifactId: string;
  readonly artifactVersion: string;
  readonly artifactSha256: string;
  readonly replaySessionId: string;
  readonly surfaceSessionId: string;
  readonly checkpointSha256: string;
  readonly completedStepIds: readonly string[];
  readonly nextStepIndex: number;
  readonly expectedHumanPageState: string;
  readonly expectedPostHumanPageState: string;
}

export interface HandoffGrant extends HandoffBinding {
  readonly handoffId: string;
  readonly resumeToken: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface HandoffResumeRequest {
  readonly handoffId: string;
  readonly resumeToken: string;
  readonly runId: string;
  readonly artifactId: string;
  readonly artifactVersion: string;
  readonly artifactSha256: string;
  readonly checkpointSha256: string;
  readonly completedStepIds: readonly string[];
}

export type HandoffValidationCode =
  | "UNKNOWN_HANDOFF"
  | "HANDOFF_MISMATCH"
  | "ARTIFACT_MISMATCH"
  | "CHECKPOINT_MISMATCH"
  | "HANDOFF_EXPIRED"
  | "HANDOFF_CONSUMED";

export type HandoffValidation =
  | { readonly valid: true; readonly binding: HandoffBinding }
  | { readonly valid: false; readonly code: HandoffValidationCode };

export interface HandoffCoordinatorOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly createToken?: () => string;
  readonly createHandoffId?: () => string;
}

interface StoredHandoff {
  readonly handoffId: string;
  readonly tokenDigest: Uint8Array;
  readonly binding: HandoffBinding;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  disposition: HandoffDisposition;
}

const UNKNOWN_TOKEN_DIGEST = createHash("sha256").update("unknown-handoff-token").digest();

function digestToken(token: string): Uint8Array {
  return createHash("sha256").update(token, "utf8").digest();
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** In-memory, single-handoff trust boundary. It never persists or logs resume tokens. */
export class HandoffCoordinator {
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #createToken: () => string;
  readonly #createHandoffId: () => string;
  #handoff: StoredHandoff | undefined;

  constructor(options: HandoffCoordinatorOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? DEFAULT_HANDOFF_TTL_MS;
    if (!Number.isFinite(this.#ttlMs) || this.#ttlMs <= 0) {
      throw new Error("Handoff TTL must be a positive finite duration.");
    }
    this.#createToken = options.createToken ?? (() => randomBytes(32).toString("base64url"));
    this.#createHandoffId = options.createHandoffId ?? (() => `handoff-${randomUUID()}`);
  }

  begin(binding: HandoffBinding): HandoffGrant {
    if (this.#handoff?.disposition === "ACTIVE") {
      throw new Error("A replay session may have only one active handoff.");
    }
    const now = this.#now();
    const resumeToken = this.#createToken();
    if (resumeToken.length < 32) throw new Error("Resume token entropy is insufficient.");
    const stored: StoredHandoff = {
      handoffId: this.#createHandoffId(),
      tokenDigest: digestToken(resumeToken),
      binding: {
        ...binding,
        completedStepIds: [...binding.completedStepIds],
      },
      createdAtMs: now,
      expiresAtMs: now + this.#ttlMs,
      disposition: "ACTIVE",
    };
    this.#handoff = stored;
    return {
      ...stored.binding,
      handoffId: stored.handoffId,
      resumeToken,
      createdAt: new Date(stored.createdAtMs).toISOString(),
      expiresAt: new Date(stored.expiresAtMs).toISOString(),
    };
  }

  validate(request: HandoffResumeRequest): HandoffValidation {
    const stored = this.#handoff;
    const suppliedDigest = digestToken(request.resumeToken);
    const expectedDigest = stored?.tokenDigest ?? UNKNOWN_TOKEN_DIGEST;
    const tokenMatches = timingSafeEqual(suppliedDigest, expectedDigest);
    if (request.handoffId !== stored?.handoffId || !tokenMatches) {
      return { valid: false, code: "UNKNOWN_HANDOFF" };
    }
    if (stored.disposition === "CONSUMED") {
      return { valid: false, code: "HANDOFF_CONSUMED" };
    }
    if (stored.disposition !== "ACTIVE") {
      return {
        valid: false,
        code: stored.disposition === "EXPIRED" ? "HANDOFF_EXPIRED" : "UNKNOWN_HANDOFF",
      };
    }
    if (this.#now() >= stored.expiresAtMs) {
      stored.disposition = "EXPIRED";
      return { valid: false, code: "HANDOFF_EXPIRED" };
    }
    const binding = stored.binding;
    if (request.runId !== binding.runId) {
      return { valid: false, code: "HANDOFF_MISMATCH" };
    }
    if (
      request.artifactId !== binding.artifactId ||
      request.artifactVersion !== binding.artifactVersion ||
      request.artifactSha256 !== binding.artifactSha256
    ) {
      return { valid: false, code: "ARTIFACT_MISMATCH" };
    }
    if (
      request.checkpointSha256 !== binding.checkpointSha256 ||
      !equalStrings(request.completedStepIds, binding.completedStepIds)
    ) {
      return { valid: false, code: "CHECKPOINT_MISMATCH" };
    }
    return { valid: true, binding };
  }

  consume(): void {
    if (!this.#handoff || this.#handoff.disposition !== "ACTIVE") {
      throw new Error("No active handoff can be consumed.");
    }
    this.#handoff.disposition = "CONSUMED";
  }

  terminate(disposition: "ABANDONED" | "EXPIRED"): void {
    if (this.#handoff?.disposition === "ACTIVE") this.#handoff.disposition = disposition;
  }

  get activeExpiresAtMs(): number | undefined {
    return this.#handoff?.disposition === "ACTIVE" ? this.#handoff.expiresAtMs : undefined;
  }
}
