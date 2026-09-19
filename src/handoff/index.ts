import type { ControlOwner } from "../domain/index.js";

/** Deterministic same-session control-transfer boundary. */
export class HandoffCoordinator {
  transfer(_owner: ControlOwner): Promise<void> {
    throw new Error("HandoffCoordinator.transfer is not implemented");
  }
}
