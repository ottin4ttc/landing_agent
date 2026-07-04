// Vitest agents embedded agent config wires the agents embedded agent test shard.
import { agentsEmbeddedTestPatterns } from "./vitest.agents-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsEmbeddedVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(agentsEmbeddedTestPatterns, {
    dir: "src/agents",
    env,
    // Suites here share the run-overflow-compaction harness, whose beforeAll
    // re-imports the full embedded-runner module graph (resetModules + ~40
    // doMocks + the 4k-line run.ts) per file; on a saturated shard that cold
    // import alone can exceed the shared 120s ceiling and cascade into bogus
    // assertion failures from a half-initialized harness. Tests here observed
    // ~12x slowdowns under the same contention, so both budgets rise together.
    hookTimeout: 300_000,
    testTimeout: 300_000,
    name: "agents-embedded-agent",
  });
}

export default createAgentsEmbeddedVitestConfig();
