import { useCallback, useState } from "react";

export interface LocalPrefs {
  dataSaver: boolean;
  reduceMotion: boolean;
}

const KEY = "wr.prefs";
const DEFAULTS: LocalPrefs = { dataSaver: false, reduceMotion: false };

export function loadPrefs(): LocalPrefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}

export function useLocalPrefs(): [LocalPrefs, (patch: Partial<LocalPrefs>) => void] {
  const [prefs, setPrefs] = useState(loadPrefs);
  const update = useCallback((patch: Partial<LocalPrefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      localStorage.setItem(KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  return [prefs, update];
}

export const prefersReducedMotion = (prefs: LocalPrefs) =>
  prefs.reduceMotion || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
