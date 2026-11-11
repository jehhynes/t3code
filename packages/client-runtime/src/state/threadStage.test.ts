// Fork-only (jehhynes/t3code#73)
import {
  EnvironmentId,
  RunId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import { v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { createEnvironmentThreadShellAtoms } from "./threadShell.ts";

const environmentId = EnvironmentId.make("environment-stage");

function makeHarness() {
  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<OrchestrationV2ShellSnapshot | null>(v2ShellSnapshot),
  );
  const catalogValueAtom = Atom.make({
    isReady: true,
    entries: new Map([
      [
        environmentId,
        {
          target: new PrimaryConnectionTarget({
            environmentId,
            label: "Environment",
            httpBaseUrl: "https://example.test",
            wsBaseUrl: "wss://example.test",
          }),
          profile: Option.none(),
          enabled: true,
        },
      ],
    ]),
  });
  return {
    registry: AtomRegistry.make(),
    snapshotAtom,
    threads: createEnvironmentThreadShellAtoms({
      catalogValueAtom,
      snapshotAtom,
      hiddenThreadTagsAtom: () => Atom.make(null),
    }),
  };
}

describe("thread stage", () => {
  it.each(["running", "waiting"] as const)(
    "keeps the quiet shell and list through stage changes while the run is %s",
    (status) => {
      const harness = makeHarness();
      const runId = RunId.make("stage-run");
      const running: OrchestrationV2ThreadShell = {
        ...v2ThreadShell,
        latestRunId: runId,
        activeRunId: status === "running" ? runId : null,
        activityRunStatus: status,
        status,
        itemCount: 1,
        visibleItemCount: 1,
      };
      const setThread = (thread: OrchestrationV2ThreadShell, sequence: number) =>
        harness.registry.set(harness.snapshotAtom(environmentId), {
          ...v2ShellSnapshot,
          snapshotSequence: sequence,
          threads: [thread],
        });
      const ref = { environmentId, threadId: v2ThreadShell.id };
      const quietAtom = harness.threads.quietThreadShellAtom(ref);
      const listAtom = harness.threads.quietThreadShellsAtom;
      const liveStage = () =>
        harness.registry.get(harness.threads.threadShellAtom(ref))?.source.stage;
      setThread(running, 1);
      const disposeQuiet = harness.registry.mount(quietAtom);
      const disposeList = harness.registry.mount(listAtom);
      try {
        const quiet = harness.registry.get(quietAtom);
        const list = harness.registry.get(listAtom);
        // Absent and explicitly undefined both read as no stage.
        const shells = [
          { ...running, stage: "Fix tests" },
          { ...running, stage: "Write docs" },
          running,
          { ...running, stage: undefined },
        ];
        for (const [index, shell] of shells.entries()) {
          setThread(shell, index + 2);
          expect(liveStage()).toBe(shell.stage);
          expect(harness.registry.get(quietAtom)).toBe(quiet);
          expect(harness.registry.get(listAtom)).toBe(list);
        }

        setThread({ ...running, stage: "Ship", title: "Renamed" }, 6);
        expect(harness.registry.get(quietAtom)?.source.stage).toBe("Ship");

        const stopped: OrchestrationV2ThreadShell = {
          ...running,
          activeRunId: null,
          activityRunStatus: null,
          status: "completed",
          title: "Renamed",
        };
        setThread(stopped, 7);
        expect(harness.registry.get(quietAtom)?.source.stage).toBeUndefined();
        expect(harness.registry.get(listAtom)).not.toBe(list);
      } finally {
        disposeQuiet();
        disposeList();
        harness.registry.dispose();
      }
    },
  );
});
