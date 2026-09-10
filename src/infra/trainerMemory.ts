import type { TrainerSearchResult } from "./decky";
import { deckyBackend } from "./decky";

// Remembers, per Steam appid, the last trainer game the user opened the
// downloads list for - so re-entering the Trainers tab for that same game
// later (after closing and reopening CheatDeck's overlay, which resets the
// in-memory TrainersStateProvider - see hooks/useTrainersState.tsx) shows
// the downloads list again instead of an empty search box. Backed by
// Decky's own per-plugin settings store (the same get_setting/set_setting
// backend calls SettingsProvider uses - see infra/settingsStorage.ts) rather
// than component state, since it needs to survive the overlay closing
// entirely, not just switching between the Normal/Advanced/Custom tabs.
const SETTING_KEY = "TrainerLastSelectionV1";

type StoredSelections = Record<string, TrainerSearchResult>;

const isTrainerSearchResult = (value: unknown): value is TrainerSearchResult => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.title === "string" &&
    candidate.title.trim() !== "" &&
    typeof candidate.url === "string" &&
    candidate.url.trim() !== ""
  );
};

const decodeStored = (value: unknown): StoredSelections => {
  if (!value || typeof value !== "object") return {};
  const result: StoredSelections = {};
  for (const [appid, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isTrainerSearchResult(entry)) result[appid] = entry;
  }
  return result;
};

export const trainerMemory = {
  async getForApp(appid: number): Promise<TrainerSearchResult | undefined> {
    const stored = decodeStored(await deckyBackend.getSetting<unknown>(SETTING_KEY, {}));
    return stored[String(appid)];
  },

  async setForApp(appid: number, game: TrainerSearchResult): Promise<void> {
    const stored = decodeStored(await deckyBackend.getSetting<unknown>(SETTING_KEY, {}));
    stored[String(appid)] = game;
    await deckyBackend.setSetting(SETTING_KEY, stored);
  },
};
