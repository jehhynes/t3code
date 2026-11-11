// Fork-only: Start with guidance opens the issue's draft thread (jehhynes/t3code#35).
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ThreadId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";

import { type ComposerThreadTarget, useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { issueEnvironment } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";

import { placeLinkedPrompt } from "../promptLinks/linkedPrompt";
import { toastManager } from "../ui/toast";
import { type WaitingIssue, draftWorkspace } from "./issueStartList.logic";

export function useIssueDraftStart() {
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();
  const prepare = useAtomCommand(issueEnvironment.preparePlaybookDraft, { reportFailure: false });
  const startOnSend = useAtomCommand(issueEnvironment.startPlaybookOnSend, {
    reportFailure: false,
  });

  return async (issue: WaitingIssue, use?: string) => {
    const { environmentId, entry } = issue;
    const failed = (description: string) =>
      toastManager.add({
        type: "error",
        title: `Could not open ${entry.displayKey} with playbook ${use ?? entry.playbook}`,
        description,
      });
    const failedWith = (result: AtomCommandResult<unknown, unknown>) => {
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      failed(
        typeof failure === "object" && failure !== null && "detail" in failure
          ? String(failure.detail)
          : String(failure),
      );
    };

    const requestingHref = router.state.location.href;
    const prepared = await prepare({
      environmentId,
      input: { playbook: entry.playbook, entry, ...(use === undefined ? {} : { use }) },
    });
    if (prepared._tag === "Failure") return failedWith(prepared);
    // As triage does, a draft I left the page for stays closed instead of pulling me back.
    if (router.state.location.href !== requestingHref) return;
    const draft = prepared.value;

    const opened = await (async (): Promise<{
      readonly target: ComposerThreadTarget;
      readonly threadId: ThreadId;
    } | null> => {
      if (draft.threadId !== null) {
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: draft.threadId },
        });
        return { target: scopeThreadRef(environmentId, draft.threadId), threadId: draft.threadId };
      }
      if (entry.projectId === null) return null;
      const created = await handleNewThread(
        scopeProjectRef(environmentId, entry.projectId),
        draftWorkspace(draft.workspace),
      ).catch(() => undefined);
      // Null when I went elsewhere meanwhile.
      if (created === null) return null;
      if (created === undefined) {
        failed("T3 Code could not open a new thread.");
        return null;
      }
      const store = useComposerDraftStore.getState();
      store.setModelSelection(created.draftId, draft.modelSelection, {
        explicit: true,
        replaceOptions: true,
      });
      store.setRuntimeMode(created.draftId, draft.runtimeMode);
      return { target: created.draftId, threadId: created.threadId };
    })();
    if (opened === null) return;
    const { target, threadId } = opened;

    placeLinkedPrompt(target, { text: draft.prompt, hiddenCharacters: 0 }, [], async () => {
      const result = await startOnSend({
        environmentId,
        input: { playbook: entry.playbook, entry, threadId },
      });
      if (result._tag === "Failure") failedWith(result);
      return result._tag === "Success";
    });
  };
}
