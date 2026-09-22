import type { SurfaceAdapter, SurfaceOperationOptions } from "../../src/browser/index.js";
import type {
  SurfaceActionResult,
  SurfaceCommand,
  SurfaceObservation,
} from "../../src/domain/index.js";

export function makeObservation(overrides: Partial<SurfaceObservation> = {}): SurfaceObservation {
  return {
    observationId: crypto.randomUUID(),
    url: "http://127.0.0.1:3000/login",
    title: "Synthetic portal",
    primaryHeading: "Employee Portal Login",
    pageState: "operator-login",
    visibleText: "Employee Portal Login",
    elements: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

export class FakeSurfaceAdapter implements SurfaceAdapter {
  observation: SurfaceObservation;
  readonly commands: SurfaceCommand[] = [];
  readonly startOptions: SurfaceOperationOptions[] = [];
  readonly observeOptions: SurfaceOperationOptions[] = [];
  readonly executeOptions: SurfaceOperationOptions[] = [];
  readonly screenshotRedactions: string[][] = [];
  readonly sessionId = crypto.randomUUID();
  closed = false;
  started = false;
  executeHandler: (
    command: SurfaceCommand,
    options?: SurfaceOperationOptions,
  ) => SurfaceActionResult | Promise<SurfaceActionResult>;

  constructor(observation = makeObservation()) {
    this.observation = observation;
    this.executeHandler = () => ({
      status: "EXECUTED",
      message: "executed",
      observation: this.observation,
    });
  }

  start(options: SurfaceOperationOptions = {}): Promise<SurfaceObservation> {
    this.started = true;
    this.startOptions.push(options);
    return Promise.resolve(this.observation);
  }

  observe(options: SurfaceOperationOptions = {}): Promise<SurfaceObservation> {
    this.observeOptions.push(options);
    return Promise.resolve(this.observation);
  }

  async execute(
    command: SurfaceCommand,
    options: SurfaceOperationOptions = {},
  ): Promise<SurfaceActionResult> {
    this.commands.push(command);
    this.executeOptions.push(options);
    const result = await this.executeHandler(command, options);
    if (result.observation) this.observation = result.observation;
    return result;
  }

  captureScreenshot(redactions: readonly string[] = []): Promise<Uint8Array> {
    this.screenshotRedactions.push([...redactions]);
    return Promise.resolve(new TextEncoder().encode("synthetic-png"));
  }

  surfaceSessionId(): string | undefined {
    return this.started && !this.closed ? this.sessionId : undefined;
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}
