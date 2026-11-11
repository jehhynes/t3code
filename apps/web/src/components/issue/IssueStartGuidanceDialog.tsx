// Fork-only: one start of a waiting issue with my guidance, or another playbook (jehhynes/t3code#26).
import { useAtomValue } from "@effect/atom-react";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { useState } from "react";

import { issueEnvironment } from "~/state/issues";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { type WaitingIssue, playbookChoices } from "./issueStartList.logic";

export interface GuidedStart {
  /** Set only when another playbook than the issue's own was chosen. */
  readonly startWith?: string;
  /** Set only when not blank; kept as typed. */
  readonly guidance?: string;
}

/** Mounted while open, so each opening starts blank with the issue's own playbook. */
export function IssueStartGuidanceDialog({
  issue,
  onOpenChange,
  onStart,
}: {
  issue: WaitingIssue;
  onOpenChange: (open: boolean) => void;
  onStart: (start: GuidedStart) => void;
}) {
  const canStart = useAtomValue(issueEnvironment.startPlaybook.permissionAtom(issue.environmentId));
  const own = issue.entry.playbook.toLowerCase();
  const choices = playbookChoices(issue);
  const [playbook, setPlaybook] = useState(
    () => choices.find((name) => name.toLowerCase() === own) ?? issue.entry.playbook,
  );
  const [guidance, setGuidance] = useState("");
  const other = playbook.toLowerCase() !== own;
  const blank = guidance.trim().length === 0;
  const ready = canStart && (other || !blank);
  const submit = () => {
    if (!ready) return;
    onStart({ ...(other ? { startWith: playbook } : {}), ...(blank ? {} : { guidance }) });
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Start with guidance</DialogTitle>
          <DialogDescription>
            {issue.entry.displayKey} {issue.entry.title}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {choices.length > 1 ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor="issue-start-playbook">Playbook</Label>
              <Select
                value={playbook}
                onValueChange={(value) => {
                  if (value !== null) setPlaybook(value);
                }}
              >
                <SelectTrigger id="issue-start-playbook" size="sm" aria-label="Playbook">
                  <SelectValue>{playbook}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {choices.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <Label htmlFor="issue-start-guidance">Guidance</Label>
            <Textarea
              id="issue-start-guidance"
              size="lg"
              autoFocus
              value={guidance}
              maxLength={PROVIDER_SEND_TURN_MAX_INPUT_CHARS}
              onChange={(event) => setGuidance(event.target.value)}
              placeholder="Added after the playbook's prompt, as you write it"
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={!ready} onClick={submit}>
            Start
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
