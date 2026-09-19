import type { SurfaceAction, SurfaceObservation } from "../domain/index.js";

/** Abstract, bounded surface contract shared by discovery and replay. */
export interface SurfaceAdapter {
  start(): Promise<SurfaceObservation>;
  observe(): Promise<SurfaceObservation>;
  execute(action: SurfaceAction): Promise<SurfaceObservation>;
  close(): Promise<void>;
}

/** Future headed-Chromium adapter. Raw Playwright is encapsulated here. */
export class PlaywrightSurface implements SurfaceAdapter {
  start(): Promise<SurfaceObservation> {
    throw new Error("PlaywrightSurface.start is not implemented");
  }

  observe(): Promise<SurfaceObservation> {
    throw new Error("PlaywrightSurface.observe is not implemented");
  }

  execute(_action: SurfaceAction): Promise<SurfaceObservation> {
    throw new Error("PlaywrightSurface.execute is not implemented");
  }

  close(): Promise<void> {
    throw new Error("PlaywrightSurface.close is not implemented");
  }
}
