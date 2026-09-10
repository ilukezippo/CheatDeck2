import type { CompatibilityTool } from "@decky/ui/dist/globals/steam-client/App";

// Steam Tinker Launch's own internal strToolName varies by install method
// (its own installer script vs. a Flatpak/distro package) and has changed
// across versions, so it's matched by display name/tool name text rather
// than a single hardcoded string. Deliberately permissive (case- and
// spacing-insensitive) rather than an exact match: SteamClient.Apps'
// GetAvailableCompatTools only ever returns tools actually installed on the
// system, so getting this wrong can only mean not finding an installed STL
// (a false negative), never mistakenly picking some other tool.
const STEAM_TINKER_LAUNCH_PATTERN = /steam\s*tinker\s*launch/i;

export const findSteamTinkerLaunch = (tools: readonly CompatibilityTool[]): CompatibilityTool | undefined =>
  tools.find(
    (tool) =>
      STEAM_TINKER_LAUNCH_PATTERN.test(tool.strDisplayName) || STEAM_TINKER_LAUNCH_PATTERN.test(tool.strToolName),
  );
