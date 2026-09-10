import { describe, expect, it } from "vitest";

import {
  compatibilityPath,
  language,
  noFsync,
  pulseLatency,
  sidecarProgram,
  steamDeckDesktopMode,
  wineD3d,
} from "../src/domain/features";
import { LaunchOptions, type LaunchOptionsEditResult } from "../src/domain/options";

const success = (result: LaunchOptionsEditResult): LaunchOptions => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

describe("features", () => {
  it("round-trips sidecar program paths and removes both assignments", () => {
    const path = `/home/deck/C:\\Games/it's "$sidecar".exe`;
    const enabled = success(sidecarProgram.set(LaunchOptions.parse(""), path));

    expect(sidecarProgram.path(enabled)).toBe(path);
    expect(enabled.getEnvironment("PROTON_REMOTE_DEBUG_CMD")).toBe(`'/home/deck/C:\\Games/it'"'"'s "$sidecar".exe'`);
    expect(sidecarProgram.directory(enabled)).toBe("/home/deck/C:\\Games");
    expect(sidecarProgram.isEnabled(enabled)).toBe(true);
    expect(success(sidecarProgram.disable(enabled)).toString()).toBe("");
  });

  it("also enables the Wine-fallback wrapper prefix when a wrapper path is given", () => {
    const path = "/home/deck/Games/MySidecar.exe";
    const wrapperPath = "/home/deck/homebrew/data/CheatDeck/sidecar-launch.sh";
    const enabled = success(sidecarProgram.set(LaunchOptions.parse(""), path, wrapperPath));

    expect(enabled.getEnvironment("CHEATDECK_SIDECAR")).toBe(path);
    expect(enabled.toString()).toContain(`bash ${wrapperPath} %command%`);
    expect(sidecarProgram.isEnabled(enabled)).toBe(true);

    const disabled = success(sidecarProgram.disable(enabled, wrapperPath));
    expect(disabled.toString()).toBe("");
    expect(disabled.hasEnvironment("CHEATDECK_SIDECAR")).toBe(false);
  });

  it("chains the wrapper ahead of an existing prefix command with the standard -- separator", () => {
    const wrapperPath = "/home/deck/homebrew/data/CheatDeck/sidecar-launch.sh";
    const withGamemode = LaunchOptions.parse("gamemoderun %command%");
    const enabled = success(sidecarProgram.set(withGamemode, "/home/deck/Games/MySidecar.exe", wrapperPath));

    expect(enabled.toString()).toContain(`bash ${wrapperPath} -- gamemoderun %command%`);
    expect(sidecarProgram.path(enabled)).toBe("/home/deck/Games/MySidecar.exe");
  });

  it("omits the wrapper prefix when no wrapper path is available, preserving prior behavior", () => {
    const path = "/home/deck/Games/MySidecar.exe";
    const enabled = success(sidecarProgram.set(LaunchOptions.parse(""), path));

    expect(enabled.hasEnvironment("CHEATDECK_SIDECAR")).toBe(false);
    expect(enabled.toString()).not.toContain("bash");
  });

  it.each([
    [`PROTON_REMOTE_DEBUG_CMD="'/home/deck/My Sidecar.exe'" %command%`, "/home/deck/My Sidecar.exe"],
    [`PROTON_REMOTE_DEBUG_CMD='"/home/deck/My Sidecar.exe"' %command%`, "/home/deck/My Sidecar.exe"],
    [`PROTON_REMOTE_DEBUG_CMD='/home/deck/My\\ Sidecar.exe' %command%`, "/home/deck/My Sidecar.exe"],
  ])("decodes a single sidecar command word from %s", (source, expected) => {
    expect(sidecarProgram.path(LaunchOptions.parse(source))).toBe(expected);
  });

  it.each([
    `PROTON_REMOTE_DEBUG_CMD='sidecar.exe --flag' %command%`,
    `PROTON_REMOTE_DEBUG_CMD="'unterminated" %command%`,
  ])("rejects an invalid sidecar command from %s", (source) => {
    expect(sidecarProgram.path(LaunchOptions.parse(source))).toBeUndefined();
  });

  it("sets and removes language assignments atomically", () => {
    const enabled = success(language.set(LaunchOptions.parse(""), "de_DE.UTF-8"));

    expect(enabled.toString()).toContain("LANG=de_DE.UTF-8");
    expect(enabled.toString()).toContain("HOST_LC_ALL=de_DE.UTF-8");
    expect(language.value(enabled)).toBe("de_DE.UTF-8");
    expect(language.isEnabled(enabled)).toBe(true);
    expect(success(language.disable(enabled)).toString()).toBe("");
  });

  it("sets and removes the compatibility path", () => {
    const enabled = success(compatibilityPath.set(LaunchOptions.parse(""), "/home/deck/prefix path"));

    expect(compatibilityPath.value(enabled)).toBe("/home/deck/prefix path");
    expect(success(compatibilityPath.disable(enabled)).toString()).toBe("");
  });

  it("switches the WineD3D compatibility renderer", () => {
    const enabled = success(wineD3d.setEnabled(LaunchOptions.parse(""), true));

    expect(wineD3d.isEnabled(enabled)).toBe(true);
    expect(enabled.toString()).toBe("PROTON_USE_WINED3D=1 %command%");
    expect(success(wineD3d.setEnabled(enabled, false)).toString()).toBe("");
  });

  it("switches games from Steam Deck to desktop behavior", () => {
    const enabled = success(steamDeckDesktopMode.setEnabled(LaunchOptions.parse(""), true));

    expect(steamDeckDesktopMode.isEnabled(enabled)).toBe(true);
    expect(enabled.toString()).toBe("SteamDeck=0 %command%");
    expect(success(steamDeckDesktopMode.setEnabled(enabled, false)).toString()).toBe("");
  });

  it("disables Proton FSYNC as a compatibility fallback", () => {
    const enabled = success(noFsync.setEnabled(LaunchOptions.parse(""), true));

    expect(noFsync.isEnabled(enabled)).toBe(true);
    expect(enabled.toString()).toBe("PROTON_NO_FSYNC=1 %command%");
    expect(success(noFsync.setEnabled(enabled, false)).toString()).toBe("");
  });

  it("sets, replaces, and restores the default PulseAudio latency", () => {
    const initial = LaunchOptions.parse("");
    const sixty = success(pulseLatency.set(initial, "60"));
    const thirty = success(pulseLatency.set(sixty, "30"));
    const restored = success(pulseLatency.set(thirty, undefined));

    expect(pulseLatency.value(initial)).toBeUndefined();
    expect(pulseLatency.value(sixty)).toBe("60");
    expect(sixty.toString()).toBe("PULSE_LATENCY_MSEC=60 %command%");
    expect(pulseLatency.value(thirty)).toBe("30");
    expect(thirty.toString()).toBe("PULSE_LATENCY_MSEC=30 %command%");
    expect(restored.toString()).toBe("");
  });

  it("fails closed without modifying malformed source", () => {
    const options = LaunchOptions.parse("%command% && bad");

    expect(sidecarProgram.set(options, "/tmp/sidecar.exe")).toEqual({
      ok: false,
      value: options,
      error: "document-not-editable",
    });
  });
});
