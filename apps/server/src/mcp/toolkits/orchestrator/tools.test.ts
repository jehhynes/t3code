import { expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { OrchestratorToolkit } from "./tools.ts";

// Oversized page sizes clamp on decode, so the schema has no `maximum`; Codex also drops
// bounds from its TypeScript view. The description is the only place a model sees a limit.
it("states t3_thread_read page size limits in the parameter descriptions", () => {
  const schema = Tool.getJsonSchema(OrchestratorToolkit.tools.t3_thread_read) as {
    readonly properties: Readonly<Record<string, { readonly description?: string }>>;
  };
  const limits = { limit: "100", runLimit: "50", maxCharsPerItem: "50000" };
  for (const [name, maximum] of Object.entries(limits)) {
    expect(schema.properties[name]?.description, name).toContain(maximum);
  }
});

it("refuses a t3_thread_update whose fields do not fit its action", () => {
  const decode = Schema.decodeUnknownExit(
    OrchestratorToolkit.tools.t3_thread_update.parametersSchema,
  );
  expect(Exit.isFailure(decode({ action: "rename" }))).toBe(true);
  expect(Exit.isFailure(decode({ action: "regenerate_title", title: "New" }))).toBe(true);
  expect(Exit.isSuccess(decode({ action: "rename", title: "New", environmentId: undefined }))).toBe(
    true,
  );
  // Fork-only (jehhynes/t3code#75)
  expect(Exit.isSuccess(decode({ action: "set_stage", stage: "2/6 verifying findings" }))).toBe(
    true,
  );
  expect(Exit.isSuccess(decode({ action: "set_stage", stage: "x".repeat(64) }))).toBe(true);
  const refusal = (input: object) => {
    const exit = decode(input);
    return Exit.isFailure(exit) ? String(exit.cause) : null;
  };
  expect(refusal({ action: "set_stage" })).toContain("set_stage requires stage");
  expect(refusal({ action: "rename", title: "New", stage: "Fix" })).toContain(
    "set_stage requires stage",
  );
  expect(refusal({ action: "set_stage", stage: "Fix", title: "New" })).toContain("rename requires");
  expect(refusal({ action: "set_stage", stage: "   " })).not.toBeNull();
  expect(refusal({ action: "set_stage", stage: "x".repeat(65) })).toContain("at most 64");
  for (const breakChar of ["\n", "\u2028", "\u2029"]) {
    expect(refusal({ action: "set_stage", stage: `Fix${breakChar}tests` })).toContain(
      "single line",
    );
  }
});
