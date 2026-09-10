import type { LaunchOptionDefinition, LaunchOptions } from "./options";
import { parseLiteralWord } from "./parser";

const definitions = {
  noFsync: { kind: "environment", name: "PROTON_NO_FSYNC", value: "1" },
  steamDeckDesktopMode: { kind: "environment", name: "SteamDeck", value: "0" },
  wineD3d: { kind: "environment", name: "PROTON_USE_WINED3D", value: "1" },
} as const satisfies Record<string, LaunchOptionDefinition>;

const keys = {
  sidecarProgram: "PROTON_REMOTE_DEBUG_CMD",
  sidecarDirectory: "PRESSURE_VESSEL_FILESYSTEMS_RW",
  sidecarReliablePath: "CHEATDECK_SIDECAR",
  language: "LANG",
  hostLanguage: "HOST_LC_ALL",
  compatibilityPath: "STEAM_COMPAT_DATA_PATH",
  pulseLatency: "PULSE_LATENCY_MSEC",
} as const;

// Command used to invoke the sidecar wrapper script (see infra/decky.ts's
// getSidecarWrapperPath and main.py's SIDECAR_WRAPPER_SCRIPT). Kept as a
// prefix command rather than folded into PROTON_REMOTE_DEBUG_CMD because some
// Proton/Wine builds stop honoring that hook silently (e.g.
// https://github.com/GloriousEggroll/proton-ge-custom/issues/664); the
// wrapper independently launches the sidecar via Wine if it detects that
// Proton's own hook did not, so both mechanisms are attempted.
const sidecarWrapperCommand = "bash";

const environment = (name: string, value: string): LaunchOptionDefinition => ({ kind: "environment", name, value });
const prefix = (command: string, argv: readonly string[] = []): LaunchOptionDefinition => ({
  kind: "prefix",
  command,
  argv,
});
const enable = (definition: LaunchOptionDefinition) => ({ kind: "enable" as const, definition });
const disable = (definition: LaunchOptionDefinition) => ({ kind: "disable" as const, definition });
const unsetEnvironment = (name: string) => disable(environment(name, ""));

const parentPath = (path: string): string => {
  const separator = path.lastIndexOf("/");
  if (separator < 0) return ".";
  return separator === 0 ? path[0] : path.slice(0, separator);
};

const encodeShlexWord = (value: string): string => `'${value.split("'").join(`'"'"'`)}'`;

const decodeShlexWord = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  return parseLiteralWord(value);
};

const toggleFeature = (definition: LaunchOptionDefinition) => ({
  isEnabled: (options: LaunchOptions): boolean => options.isEnabled(definition),
  setEnabled: (options: LaunchOptions, enabled: boolean) => options.setEnabled(definition, enabled),
});

export const sidecarProgram = {
  path: (options: LaunchOptions): string | undefined => decodeShlexWord(options.getEnvironment(keys.sidecarProgram)),
  directory: (options: LaunchOptions): string | undefined => options.getEnvironment(keys.sidecarDirectory),
  isEnabled: (options: LaunchOptions): boolean => options.hasEnvironment(keys.sidecarProgram),
  // wrapperPath, when provided (see infra/decky.ts's getSidecarWrapperPath),
  // also enables the Wine-fallback wrapper prefix command as a second,
  // independent way to launch the sidecar alongside Proton's own
  // PROTON_REMOTE_DEBUG_CMD hook. Omit it to preserve the exact previous
  // behavior (used by existing configurations and tests).
  set: (options: LaunchOptions, path: string, wrapperPath?: string) =>
    options.edit([
      enable(environment(keys.sidecarProgram, encodeShlexWord(path))),
      enable(environment(keys.sidecarDirectory, parentPath(path))),
      ...(wrapperPath
        ? [enable(environment(keys.sidecarReliablePath, path)), enable(prefix(sidecarWrapperCommand, [wrapperPath]))]
        : []),
    ]),
  disable: (options: LaunchOptions, wrapperPath?: string) =>
    options.edit([
      unsetEnvironment(keys.sidecarProgram),
      unsetEnvironment(keys.sidecarDirectory),
      unsetEnvironment(keys.sidecarReliablePath),
      ...(wrapperPath ? [disable(prefix(sidecarWrapperCommand, [wrapperPath]))] : []),
    ]),
};

export const language = {
  value: (options: LaunchOptions): string | undefined => options.getEnvironment(keys.language),
  isEnabled: (options: LaunchOptions): boolean =>
    options.hasEnvironment(keys.language) || options.hasEnvironment(keys.hostLanguage),
  set: (options: LaunchOptions, value: string) =>
    options.edit([enable(environment(keys.language, value)), enable(environment(keys.hostLanguage, value))]),
  disable: (options: LaunchOptions) =>
    options.edit([unsetEnvironment(keys.language), unsetEnvironment(keys.hostLanguage)]),
};

export const compatibilityPath = {
  value: (options: LaunchOptions): string | undefined => options.getEnvironment(keys.compatibilityPath),
  set: (options: LaunchOptions, value: string) => options.setEnabled(environment(keys.compatibilityPath, value), true),
  disable: (options: LaunchOptions) => options.edit([unsetEnvironment(keys.compatibilityPath)]),
};

export const pulseLatency = {
  value: (options: LaunchOptions): string | undefined => options.getEnvironment(keys.pulseLatency),
  set: (options: LaunchOptions, value: string | undefined) =>
    value === undefined
      ? options.edit([unsetEnvironment(keys.pulseLatency)])
      : options.edit([unsetEnvironment(keys.pulseLatency), enable(environment(keys.pulseLatency, value))]),
};

export const noFsync = toggleFeature(definitions.noFsync);
export const steamDeckDesktopMode = toggleFeature(definitions.steamDeckDesktopMode);
export const wineD3d = toggleFeature(definitions.wineD3d);
