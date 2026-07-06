// Research autocapture helpers decide when skill research signals should be captured.
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { readWorkspaceSkillFile } from "../lifecycle/workspace-skill-write.js";
import { resolveSkillWorkshopConfig } from "../workshop/config.js";
import { listSkillProposals, proposeCreateSkill, proposeUpdateSkill } from "../workshop/service.js";
import { resolveSkillProposalTarget } from "../workshop/store.js";
import { extractDurableInstructionProposals, type WorkspaceSkillSummary } from "./signals.js";

type SkillResearchAgentEndEvent = {
  messages: unknown[];
  success?: boolean;
};

type SkillResearchAgentContext = {
  agentId?: string;
  runId?: string;
  sessionKey?: string;
  trigger?: string;
  workspaceDir?: string;
};

const log = createSubsystemLogger("skills/research");
const AUTO_CAPTURE_BLOCKED_TRIGGERS = new Set(["cron", "heartbeat", "memory", "overflow"]);
const AUTO_CAPTURE_BLOCKED_SESSION_SEGMENTS = new Set(["cron", "hook", "subagent"]);
const MAX_WORKSPACE_SKILL_SUMMARIES = 200;

// Captured updates append below existing skill text so learned context stays auditable.
function buildAutoCaptureUpdateContent(existingSkill: string, capturedContent: string): string {
  return [existingSkill.trimEnd(), "", "## Captured Update", "", capturedContent.trim(), ""].join(
    "\n",
  );
}

function isSkillResearchAutoCaptureEligible(ctx: SkillResearchAgentContext): boolean {
  const trigger = ctx.trigger?.trim().toLowerCase();
  if (trigger && AUTO_CAPTURE_BLOCKED_TRIGGERS.has(trigger)) {
    return false;
  }

  const sessionKey = ctx.sessionKey?.trim().toLowerCase();
  if (!sessionKey) {
    return true;
  }
  if (sessionKey.includes("active-memory")) {
    return false;
  }
  return !sessionKey
    .split(":")
    .some((segment) => AUTO_CAPTURE_BLOCKED_SESSION_SEGMENTS.has(segment));
}

function readFrontmatterField(content: string, field: string): string | undefined {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const match = frontmatter.match(new RegExp(`^\\s*${field}:\\s*["']?([^"'\\n]+)`, "m"));
  return match?.[1]?.trim() || undefined;
}

// Summaries let the signal extractor route corrections to the skill they are about instead of
// piling everything into a generic learned-workflows skill.
async function listWorkspaceSkillSummaries(workspaceDir: string): Promise<WorkspaceSkillSummary[]> {
  const skillsDir = path.join(workspaceDir, "skills");
  let entries: string[];
  try {
    entries = (await fs.readdir(skillsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const summaries: WorkspaceSkillSummary[] = [];
  for (const name of entries.slice(0, MAX_WORKSPACE_SKILL_SUMMARIES)) {
    try {
      // Reuse the proposal target resolver + safe reader so summary scans obey the same
      // workspace containment and symlink/hardlink rejection as every other skill read.
      const target = resolveSkillProposalTarget({ workspaceDir, skillName: name });
      if (target.skillKey !== name) {
        continue;
      }
      const content = await readWorkspaceSkillFile(target.skillFile);
      if (content === null) {
        continue;
      }
      const description = readFrontmatterField(content, "description");
      summaries.push(description ? { name, description } : { name });
    } catch {
      // Directories that don't resolve to a safe, readable SKILL.md are not live skills.
    }
  }
  return summaries;
}

/**
 * Captures durable skill research signals from a session transcript when enabled.
 *
 * Runs regardless of the turn's success flag: the extracted signals are the user's own words,
 * which stay valid when a run fails — corrections given in a failed or timed-out turn are the
 * ones most worth keeping.
 */
export async function runSkillResearchAutoCapture(params: {
  event: SkillResearchAgentEndEvent;
  ctx: SkillResearchAgentContext;
  config?: OpenClawConfig;
}): Promise<void> {
  const workshopConfig = resolveSkillWorkshopConfig(params.config);
  if (!workshopConfig.autonomous.enabled) {
    return;
  }
  const workspaceDir = params.ctx.workspaceDir;
  if (!workspaceDir) {
    return;
  }
  if (!isSkillResearchAutoCaptureEligible(params.ctx)) {
    return;
  }

  const existingSkills = await listWorkspaceSkillSummaries(workspaceDir);
  const proposals = extractDurableInstructionProposals({
    messages: params.event.messages,
    existingSkills,
  });
  if (proposals.length === 0) {
    return;
  }

  const manifest = await listSkillProposals({ workspaceDir });
  for (const proposal of proposals) {
    if (
      manifest.proposals.some(
        (entry) =>
          (entry.status === "pending" || entry.status === "quarantined") &&
          entry.skillKey === proposal.skillName,
      )
    ) {
      continue;
    }

    try {
      const target = resolveSkillProposalTarget({
        workspaceDir,
        skillName: proposal.skillName,
      });
      const existingSkill = await readWorkspaceSkillFile(target.skillFile);
      const result =
        existingSkill === null
          ? await proposeCreateSkill({
              workspaceDir,
              config: params.config,
              name: proposal.skillName,
              description: proposal.description,
              content: proposal.content,
              createdBy: "skill-workshop",
              goal: proposal.goal,
              evidence: proposal.evidence,
            })
          : await proposeUpdateSkill({
              workspaceDir,
              config: params.config,
              agentId: params.ctx.agentId,
              skillName: proposal.skillName,
              description: proposal.description,
              content: buildAutoCaptureUpdateContent(existingSkill, proposal.content),
              createdBy: "skill-workshop",
              goal: proposal.goal,
              evidence: proposal.evidence,
            });
      log.info(
        `skill research auto-capture queued workshop proposal ${result.record.target.skillKey}`,
      );
    } catch (error) {
      log.warn(`skill research auto-capture skipped ${proposal.skillName}: ${String(error)}`);
    }
  }
}
