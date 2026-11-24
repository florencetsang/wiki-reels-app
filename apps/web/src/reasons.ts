import { fieldLabel } from "@wiki-reels/shared/fields";
import type { Reason } from "@wiki-reels/shared";

export function reasonText(reason: Reason, field: string): string {
  const label = fieldLabel(field);
  switch (reason.kind) {
    case "picked":
      return `Because you picked ${label}`;
    case "similar":
      return reason.anchor ? `Because you enjoyed ${reason.anchor}` : `Similar to reels you enjoyed`;
    case "explore":
      return `Exploring: ${label}`;
    case "popular":
      return `Popular in ${label}`;
    case "topic":
      return `In ${label}, picked for you`;
  }
}

export const FIELD_HUES: Record<string, number> = {
  people: 20,
  history: 35,
  geography: 140,
  arts: 320,
  philosophy_religion: 270,
  everyday_life: 50,
  society: 200,
  biology_health: 100,
  physical_sciences: 230,
  technology: 180,
  mathematics: 0,
};
