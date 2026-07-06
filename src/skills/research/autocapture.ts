// Research autocapture helpers decide when skill research signals should be captured.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { readWorkspaceSkillFile } from "../lifecycle/workspace-skill-write.js";
import { resolveSkillWorkshopConfig } from "../workshop/config.js";
import {
  listSkillProposals,
  listWritableWorkspaceSkillSummaries,
  proposeCreateSkill,
  proposeUpdateSkill,
} from "../workshop/service.js";
import { resolveSkillProposalTarget } from "../workshop/store.js";
import { extractDurableInstructionProposals } from "./signals.js";

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

  // Same status discovery as proposeUpdateSkill, so a routed correction always lands on a
  // skill an update proposal can actually write (including .agents/skills project skills).
  const existingSkills = listWritableWorkspaceSkillSummaries(workspaceDir, {
    config: params.config,
    agentId: params.ctx.agentId,
  });
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
      // A routed proposal matches a writable skill summary; its filePath is the live SKILL.md.
      // Inferred-topic proposals fall back to the flat layout the workshop uses for creates.
      const matched = existingSkills.find((entry) => entry.name === proposal.skillName);
      const skillFile =
        matched?.filePath ??
        resolveSkillProposalTarget({ workspaceDir, skillName: proposal.skillName }).skillFile;
      const existingSkill = await readWorkspaceSkillFile(skillFile);
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
