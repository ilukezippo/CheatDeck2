import { Focusable } from "@decky/ui";
import { type FC, useState } from "react";
import { FaGlobe, FaWindowRestore } from "react-icons/fa";

import { type DropdownPreset, LaunchOptionsPreview, ToggleDropdown, ToggleFilePicker } from "../components";
import { LangCodes } from "../data/languageCodes.json";
import { language, sidecarProgram } from "../domain/features";
import { useOptions, useSidecarWrapperPath } from "../hooks";
import { browseFiles, getHomePath } from "../infra/decky";
import { t } from "../utils/translate";

const Normal: FC = () => {
  const { options, editable, applyEdit } = useOptions();
  const [showSidecar, setShowSidecar] = useState(sidecarProgram.isEnabled(options));
  const [showLang, setShowLang] = useState(language.isEnabled(options));
  // Path to the Wine-fallback wrapper script (see domain/features.ts). When
  // unavailable, sidecarProgram.set/disable fall back to their previous,
  // Proton-hook-only behavior automatically.
  const wrapperPath = useSidecarWrapperPath();

  const handleSidecarBrowse = async () => {
    const defaultPath = sidecarProgram.directory(options) ?? (await getHomePath());
    const filePickerRes = await browseFiles(defaultPath, true, ["exe", "bat"]);
    const result = sidecarProgram.set(options, filePickerRes.path, wrapperPath);
    if (!result.ok || !applyEdit(result)) setShowSidecar(false);
  };

  return (
    <Focusable style={{ display: "flex", flexDirection: "column" }}>
      <LaunchOptionsPreview />

      <ToggleFilePicker
        label={t("NORMAL_SIDECAR_TOGGLE_LABEL")}
        description={t("NORMAL_SIDECAR_TOGGLE_DESC")}
        icon={<FaWindowRestore />}
        disabled={!editable}
        checked={showSidecar || sidecarProgram.isEnabled(options)}
        onToggle={(enable: boolean) => {
          if (enable) {
            setShowSidecar(true);
            return;
          }
          const result = sidecarProgram.disable(options, wrapperPath);
          if (result.ok && applyEdit(result)) setShowSidecar(false);
        }}
        value={sidecarProgram.path(options)}
        onBrowse={handleSidecarBrowse}
      />

      <ToggleDropdown
        label={t("NORMAL_LANG_TOGGLE_LABEL")}
        description={t("NORMAL_LANG_TOGGLE_DESC")}
        icon={<FaGlobe />}
        disabled={!editable}
        checked={showLang || language.isEnabled(options)}
        onToggle={(enable: boolean) => {
          if (enable) {
            setShowLang(true);
            return;
          }
          const result = language.disable(options);
          if (result.ok && applyEdit(result)) setShowLang(false);
        }}
        fieldLabel={t("NORMAL_LANG_LABEL")}
        value={language.value(options)}
        onInput={(value: string) => {
          const result = language.set(options, value);
          if (!result.ok || !applyEdit(result)) setShowLang(false);
        }}
        preset={LangCodes as DropdownPreset[]}
      />
    </Focusable>
  );
};

export default Normal;
