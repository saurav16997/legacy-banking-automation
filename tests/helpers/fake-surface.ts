import type { SurfaceAdapter } from "../../src/browser/index.js";
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
  readonly screenshotRedactions: string[][] = [];
  closed = false;
  executeHandler: (command: SurfaceCommand) => SurfaceActionResult | Promise<SurfaceActionResult>;

  constructor(observation = makeObservation()) {
    this.observation = observation;
    this.executeHandler = () => ({
      status: "EXECUTED",
      message: "executed",
      observation: this.observation,
    });
  }

  start(): Promise<SurfaceObservation> {
    return Promise.resolve(this.observation);
  }

  observe(): Promise<SurfaceObservation> {
    return Promise.resolve(this.observation);
  }

  async execute(command: SurfaceCommand): Promise<SurfaceActionResult> {
    this.commands.push(command);
    const result = await this.executeHandler(command);
    if (result.observation) this.observation = result.observation;
    return result;
  }

  captureScreenshot(redactions: readonly string[] = []): Promise<Uint8Array> {
    this.screenshotRedactions.push([...redactions]);
    return Promise.resolve(new TextEncoder().encode("synthetic-png"));
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}
