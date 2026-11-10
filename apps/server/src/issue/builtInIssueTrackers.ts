import type { IssueTrackerDriver } from "@t3tools/issue-tracker-core/server/driver";
import * as LinearIssueTrackerDriver from "@t3tools/issue-tracker-linear/server/issueTrackerDriver";

// Git hosts' trackers come with their source control driver instances; these stand alone.
const drivers = [LinearIssueTrackerDriver.driver];

export type BuiltInIssueTrackersEnv =
  (typeof drivers)[number] extends IssueTrackerDriver<infer R> ? R : never;

export const BUILT_IN_ISSUE_TRACKERS: ReadonlyArray<IssueTrackerDriver<BuiltInIssueTrackersEnv>> =
  drivers;
