import express, { type Express } from "express";

/** Express application shell for the future synthetic legacy banking portal. */
export const app: Express = express();

/** Start the local target only when explicitly invoked by the npm script. */
export function startTargetServer(): never {
  throw new Error("The synthetic target portal is not implemented");
}
