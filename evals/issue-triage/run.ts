import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../apps/server/src/config.ts";
import { buildTriagePrompt } from "../../apps/server/src/issue/triagePrompt.ts";
import { hasClaudeManagedMcpConfig } from "../../apps/server/src/provider/Drivers/ClaudeHome.ts";
import { makeClaudeTextGeneration } from "../../apps/server/src/textGeneration/ClaudeTextGeneration.ts";
import { cases, choices, triage } from "./cases.ts";
import { passes } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string" },
    case: { type: "string" },
    baseline: { type: "string" },
    samples: { type: "string", default: "3" },
  },
});
const { out, model } = values;
const samples = Number(values.samples);
const fixtures = cases.filter((fixture) => !values.case || fixture.id === values.case);
if (!out || !model || !fixtures.length || !Number.isSafeInteger(samples) || samples < 1) {
  throw new Error(
    "Use --out <directory> --model <Claude model> [--case <id>] [--samples <count>] [--baseline <results.json>].",
  );
}
const Results = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      sample: Schema.Number,
      model: Schema.String,
      expected: Schema.String,
      answer: Schema.String,
      pass: Schema.Boolean,
    }),
  ),
);
const decodeResults = Schema.decodeEffect(Results);
const decodeSettings = Schema.decodeEffect(ClaudeSettings);
const encodeRows = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-issue-triage-eval-" });
    // As the server refuses it: a managed MCP config would give the classifier tools.
    if (yield* hasClaudeManagedMcpConfig().pipe(Effect.orElseSucceed(() => true))) {
      return yield* Effect.die(
        new Error("A managed Claude MCP config is present; triage runs only without one."),
      );
    }
    const baseline = values.baseline
      ? yield* fs.readFileString(values.baseline).pipe(Effect.flatMap(decodeResults))
      : [];
    if (baseline.some((row) => row.model !== model)) {
      return yield* Effect.die(new Error("Compare against a baseline of the same model."));
    }
    const service = yield* makeClaudeTextGeneration(yield* decodeSettings({}));
    const results: Array<{
      readonly id: string;
      readonly sample: number;
      readonly model: string;
      readonly expected: string;
      readonly answer: string;
      readonly pass: boolean;
    }> = [];
    for (const fixture of fixtures) {
      const prompt = buildTriagePrompt({
        triage,
        choices,
        issue: fixture.issue,
        now: "2026-11-11T12:00:00.000Z",
        frameId: "a1b2c3d4e5f6",
      });
      for (let sample = 1; sample <= samples; sample++) {
        const answer = yield* service
          .generateTranscriptionPostProcessing({
            cwd,
            prompt,
            modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model },
          })
          .pipe(
            Effect.map((generated) => generated.transcription),
            Effect.catch((error) => Effect.succeed(`(failed: ${error.detail})`)),
          );
        const pass = passes(answer, fixture.expected, choices);
        results.push({ id: fixture.id, sample, model, expected: fixture.expected, answer, pass });
        yield* Effect.log(`${fixture.id} #${sample}: ${pass ? "pass" : "FAIL"} (${answer})`);
      }
    }
    const failing = (rows: ReadonlyArray<{ readonly id: string; readonly pass: boolean }>) =>
      fixtures.filter((fixture) => {
        const own = rows.filter((row) => row.id === fixture.id);
        return own.length > 0 && own.filter((row) => !row.pass).length * 2 >= own.length;
      });
    const failedCases = failing(results);
    yield* fs.makeDirectory(out, { recursive: true });
    yield* fs.writeFileString(path.join(out, "results.json"), yield* encodeRows(results));
    yield* fs.writeFileString(
      path.join(out, "summary.json"),
      yield* encodeRows({
        model,
        calls: results.length,
        failedCases: failedCases.map((fixture) => fixture.id),
        ...(values.baseline
          ? { baselineFailedCases: failing(baseline).map((fixture) => fixture.id) }
          : {}),
      }),
    );
    yield* Effect.log(
      failedCases.length === 0
        ? `All ${fixtures.length} cases pass (${results.length} calls).`
        : `Failing cases: ${failedCases.map((fixture) => fixture.id).join(", ")}`,
    );
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-issue-triage-eval-state-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
