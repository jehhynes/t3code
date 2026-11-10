// Tracker packages must not import the server, so standalone trackers read their saved
// credential through this service. Git-host trackers use their CLIs' own credentials.
import type { IssueTrackerKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { IssueTrackerError } from "./IssueTracker.ts";

export class IssueTrackerHost extends Context.Service<
  IssueTrackerHost,
  {
    readonly credentials: {
      /** Read fresh on each call, so a credential saved in Settings applies without a restart. */
      readonly get: (
        tracker: IssueTrackerKind,
      ) => Effect.Effect<Option.Option<string>, IssueTrackerError>;
    };
  }
>()("@t3tools/issue-tracker-core/server/IssueTrackerHost") {}
