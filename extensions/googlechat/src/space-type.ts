import type { GoogleChatSpace } from "./types.js";

export function isGoogleChatGroupSpace(space: GoogleChatSpace): boolean {
  const spaceType = (space.spaceType ?? "").toUpperCase();
  // Modern spaceType values take precedence over deprecated type data.
  if (spaceType === "DIRECT_MESSAGE") {
    return false;
  }
  if (spaceType === "SPACE" || spaceType === "GROUP_CHAT") {
    return true;
  }
  return space.singleUserBotDm !== true && (space.type ?? "").toUpperCase() !== "DM";
}
