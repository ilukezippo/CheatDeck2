import { useEffect, useState } from "react";

import { getSidecarWrapperPath } from "../infra/decky";

// Resolves the path to the Wine-fallback sidecar wrapper script main.py
// writes on load (see SIDECAR_WRAPPER_SCRIPT in main.py and
// domain/features.ts's sidecarProgram). Returns undefined until resolved, or
// forever if it can't be determined, in which case callers should treat the
// reliable-launch wrapper as unavailable and fall back to the previous,
// Proton-hook-only sidecar behavior.
export const useSidecarWrapperPath = (): string | undefined => {
  const [wrapperPath, setWrapperPath] = useState<string | undefined>();

  useEffect(() => {
    let active = true;
    void getSidecarWrapperPath().then((path) => {
      if (active) setWrapperPath(path);
    });
    return () => {
      active = false;
    };
  }, []);

  return wrapperPath;
};
