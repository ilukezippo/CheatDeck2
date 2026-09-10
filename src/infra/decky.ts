import { callable, type FilePickerRes, FileSelectionType, openFilePicker, type ToastData, toaster } from "@decky/api";

const getEnvironmentValue = callable<[string], string>("get_env");
const getSettingValue = callable<[{ key: string; defaults: unknown }], unknown>("get_setting");
const setSettingValue = callable<[{ key: string; value: unknown }], unknown>("set_setting");

export const deckyBackend = {
  getEnvironmentValue,

  async getSetting<T>(key: string, defaultValue: T): Promise<T> {
    return (await getSettingValue({ key, defaults: defaultValue })) as T;
  },

  async setSetting<T>(key: string, value: T): Promise<void> {
    await setSettingValue({ key, value });
  },
};

export const getHomePath = (): Promise<string> => deckyBackend.getEnvironmentValue("DECKY_USER_HOME");

// Path to the sidecar wrapper script main.py writes into the plugin's
// runtime data directory on load (see SIDECAR_WRAPPER_SCRIPT in main.py).
// Resolved at runtime rather than hardcoded since DECKY_PLUGIN_RUNTIME_DIR
// depends on where decky is installed. Returns undefined if it can't be
// determined, in which case callers should fall back to the previous,
// Proton-hook-only sidecar behavior.
export const getSidecarWrapperPath = async (): Promise<string | undefined> => {
  try {
    const runtimeDir = await deckyBackend.getEnvironmentValue("DECKY_PLUGIN_RUNTIME_DIR");
    return runtimeDir ? `${runtimeDir}/sidecar-launch.sh` : undefined;
  } catch {
    return undefined;
  }
};

export interface TrainerSearchResult {
  title: string;
  url: string;
}

export interface TrainerDownloadOption {
  label: string;
  url: string;
}

export interface TrainerDownloadResult {
  ok: boolean;
  path?: string;
  error?: string;
}

const searchTrainersCall = callable<[{ query: string }], TrainerSearchResult[]>("search_trainers");
const getTrainerDownloadsCall = callable<[{ url: string }], TrainerDownloadOption[]>("get_trainer_downloads");
const downloadTrainerCall = callable<
  [{ url: string; appid: number; game_name: string; label: string }],
  TrainerDownloadResult
>("download_trainer");

// Trainer search/download runs on the backend (Python, on-device) rather than
// in the frontend webview: it needs real filesystem access to extract the
// downloaded archive and, in practice, Steam's CEF webview does not allow
// arbitrary cross-origin fetch() calls the way a normal backend HTTP request
// can. See main.py for the FLiNG Trainer (https://flingtrainer.com) scraping
// implementation.
export const trainers = {
  search: (query: string): Promise<TrainerSearchResult[]> => searchTrainersCall({ query }),
  listDownloads: (url: string): Promise<TrainerDownloadOption[]> => getTrainerDownloadsCall({ url }),
  download: (url: string, appid: number, gameName: string, label: string): Promise<TrainerDownloadResult> =>
    downloadTrainerCall({ url, appid, game_name: gameName, label }),
};

export type FilePickerFilter = RegExp | ((file: File) => boolean) | undefined;

export const browseFiles = (
  startPath: string,
  includeFiles?: boolean,
  validFileExtensions?: string[],
  filter?: FilePickerFilter,
  defaultHidden?: boolean,
): Promise<FilePickerRes> => {
  return new Promise((resolve, reject) => {
    openFilePicker(
      FileSelectionType.FILE,
      startPath,
      includeFiles,
      true,
      filter,
      validFileExtensions,
      defaultHidden,
      false,
    ).then(resolve, () => reject("User Canceled"));
  });
};

export const sendNotice = (msg: string) => {
  const toastData: ToastData = {
    title: "CheatDeck 2",
    body: msg,
    duration: 2000,
    playSound: true,
    showToast: true,
  };
  toaster.toast(toastData);
};
