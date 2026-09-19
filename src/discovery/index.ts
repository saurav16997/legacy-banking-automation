/** Request accepted by the sole future probabilistic discovery agent. */
export interface DiscoveryRequest {
  readonly objective: string;
}

/** Placeholder boundary for the only component allowed to use `@openai/agents`. */
export class DiscoveryAgent {
  discover(_request: DiscoveryRequest): Promise<void> {
    throw new Error("DiscoveryAgent.discover is not implemented");
  }
}
