import { describe, expect, it } from "vitest";

import { findSteamTinkerLaunch } from "../src/domain/steamTinkerLaunch";

describe("findSteamTinkerLaunch", () => {
  it("finds Steam Tinker Launch by its display name", () => {
    const tools = [
      { strToolName: "proton_experimental", strDisplayName: "Proton Experimental" },
      { strToolName: "steamtinkerlaunch", strDisplayName: "Steam Tinker Launch" },
    ];
    expect(findSteamTinkerLaunch(tools)?.strToolName).toBe("steamtinkerlaunch");
  });

  it("matches regardless of case or spacing in either field", () => {
    const tools = [{ strToolName: "SteamTinkerLaunch-1.0", strDisplayName: "steamtinkerlaunch" }];
    expect(findSteamTinkerLaunch(tools)).toBe(tools[0]);
  });

  it("matches on strToolName even if strDisplayName doesn't mention it", () => {
    const tools = [{ strToolName: "Proton-SteamTinkerLaunch", strDisplayName: "Custom Proton Build" }];
    expect(findSteamTinkerLaunch(tools)).toBe(tools[0]);
  });

  it("returns undefined when Steam Tinker Launch isn't installed", () => {
    const tools = [
      { strToolName: "proton_experimental", strDisplayName: "Proton Experimental" },
      { strToolName: "proton_9", strDisplayName: "Proton 9.0" },
    ];
    expect(findSteamTinkerLaunch(tools)).toBeUndefined();
  });

  it("returns undefined for an empty tool list", () => {
    expect(findSteamTinkerLaunch([])).toBeUndefined();
  });

  it("does not false-positive on unrelated tools with partial word overlap", () => {
    const tools = [
      { strToolName: "steam_linux_runtime", strDisplayName: "Steam Linux Runtime" },
      { strToolName: "tinker_tools", strDisplayName: "Tinker Tools" },
    ];
    expect(findSteamTinkerLaunch(tools)).toBeUndefined();
  });
});
