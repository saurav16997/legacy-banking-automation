import type { DiscoveryInputDefinition } from "./contracts.js";

export class UnknownInputReferenceError extends Error {
  constructor(inputRef: string) {
    super(`Unknown input reference: ${inputRef}`);
    this.name = "UnknownInputReferenceError";
  }
}

export interface VaultInput {
  readonly definition: DiscoveryInputDefinition;
  readonly value: string;
}

interface VaultRedaction {
  readonly name: string;
  readonly value: string;
}

export class InputVault {
  readonly #inputs: ReadonlyMap<string, VaultInput>;
  readonly #redactions: readonly VaultRedaction[];

  constructor(inputs: readonly VaultInput[], redactions: readonly VaultRedaction[] = []) {
    this.#inputs = new Map(inputs.map((input) => [input.definition.name, input]));
    this.#redactions = redactions;
  }

  definitions(): DiscoveryInputDefinition[] {
    return [...this.#inputs.values()].map(({ definition }) => ({ ...definition }));
  }

  has(inputRef: string): boolean {
    return this.#inputs.has(inputRef);
  }

  resolve(inputRef: string): string {
    const input = this.#inputs.get(inputRef);
    if (!input) throw new UnknownInputReferenceError(inputRef);
    return input.value;
  }

  redactionValues(): string[] {
    return [
      ...[...this.#inputs.values()].map((input) => input.value),
      ...this.#redactions.map((redaction) => redaction.value),
    ].filter((value) => value.length > 0);
  }

  sanitize<T>(value: T): T {
    return this.#sanitizeUnknown(structuredClone(value)) as T;
  }

  #sanitizeUnknown(value: unknown): unknown {
    if (typeof value === "string") {
      let sanitized = value;
      for (const input of this.#inputs.values()) {
        if (!input.value) continue;
        const placeholder = input.definition.sensitive
          ? `[REDACTED:${input.definition.name}]`
          : `[INPUT:${input.definition.name}]`;
        sanitized = sanitized.split(input.value).join(placeholder);
      }
      for (const redaction of this.#redactions) {
        if (!redaction.value) continue;
        sanitized = sanitized.split(redaction.value).join(`[REDACTED:${redaction.name}]`);
      }
      return sanitized;
    }
    if (Array.isArray(value)) return value.map((item) => this.#sanitizeUnknown(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.#sanitizeUnknown(item)]),
      );
    }
    return value;
  }
}

export function createCanonicalInputVault(portalPassword: string): InputVault {
  return new InputVault(
    [
      {
        definition: {
          name: "operator_username",
          description: "Synthetic employee-portal operator username",
          sensitive: false,
        },
        value: "demo.operator",
      },
      {
        definition: {
          name: "portal_password",
          description: "Employee-portal password supplied by the local runtime",
          sensitive: true,
        },
        value: portalPassword,
      },
      {
        definition: {
          name: "member_id",
          description: "Synthetic member identifier to locate",
          sensitive: true,
        },
        value: "M-10042",
      },
      {
        definition: {
          name: "product_name",
          description: "Savings product to prepare",
          sensitive: false,
        },
        value: "Growth Savings",
      },
      {
        definition: {
          name: "account_nickname",
          description: "Nickname for the prepared savings subaccount",
          sensitive: false,
        },
        value: "Vacation Fund",
      },
      {
        definition: {
          name: "initial_deposit",
          description: "Initial deposit decimal amount",
          sensitive: true,
        },
        value: "250.00",
      },
      {
        definition: {
          name: "funding_account",
          description: "Funding-account display label",
          sensitive: true,
        },
        value: "Everyday Checking — checking ending 1842",
      },
    ],
    [
      { name: "member_name", value: "Morgan Redwood" },
      { name: "funding_account_suffix", value: "1842" },
    ],
  );
}
