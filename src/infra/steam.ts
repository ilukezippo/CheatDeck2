import type { AppDetails, CompatibilityTool } from "@decky/ui/dist/globals/steam-client/App";

export const registerForAppDetails = (appid: number, onDetails: (details: AppDetails) => void) =>
  SteamClient.Apps.RegisterForAppDetails(appid, onDetails);

export const setAppLaunchOptions = (appid: number, options: string): void => {
  SteamClient.Apps.SetAppLaunchOptions(appid, options);
};

// Backs the same "Force the use of a specific Steam Play compatibility
// tool" checkbox as Properties > Compatibility in the Steam UI itself -
// SpecifyCompatTool is the actual SteamClient method that checkbox calls
// (confirmed against @decky/ui's own bundled SteamClient typings, not
// guessed). GetAvailableCompatTools lists what's actually installed for
// this appid, each with the exact strToolName SpecifyCompatTool expects -
// that name varies by install method/version, so it has to be looked up
// rather than hardcoded (see domain/steamTinkerLaunch.ts for the matching
// logic against this list).
export const getAvailableCompatTools = (appid: number): Promise<CompatibilityTool[]> =>
  SteamClient.Apps.GetAvailableCompatTools(appid);

export const specifyCompatTool = (appid: number, toolName: string): void => {
  SteamClient.Apps.SpecifyCompatTool(appid, toolName);
};
