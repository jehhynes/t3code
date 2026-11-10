// Git hosts' trackers come with their source control driver instance; a standalone tracker
// (Linear, Jira) ships one of these, and `make`'s `R` is what the server must provide.
import type { IssueTrackerKind } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { IssueTrackerApi } from "./IssueTracker.ts";

export interface IssueTrackerDriver<R = never> {
  readonly kind: IssueTrackerKind;
  readonly make: Effect.Effect<IssueTrackerApi, never, R>;
}

/** Declares a driver with its `R` inferred from `make`. */
export const defineIssueTrackerDriver = <R>(driver: IssueTrackerDriver<R>): IssueTrackerDriver<R> =>
  driver;
