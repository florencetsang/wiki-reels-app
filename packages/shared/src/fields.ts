/** Top-level Vital Articles fields. Slugs match `vital_field` written by wiki-reels-generator. */
export const FIELDS = [
  { id: "people", label: "People", emoji: "🧑‍🔬" },
  { id: "history", label: "History", emoji: "🏛️" },
  { id: "geography", label: "Geography", emoji: "🗺️" },
  { id: "arts", label: "Arts", emoji: "🎨" },
  { id: "philosophy_religion", label: "Philosophy & religion", emoji: "🕯️" },
  { id: "everyday_life", label: "Everyday life", emoji: "🍜" },
  { id: "society", label: "Society & social sciences", emoji: "⚖️" },
  { id: "biology_health", label: "Biology & health", emoji: "🧬" },
  { id: "physical_sciences", label: "Physical sciences", emoji: "🔭" },
  { id: "technology", label: "Technology", emoji: "⚙️" },
  { id: "mathematics", label: "Mathematics", emoji: "∑" },
] as const;

export type FieldId = (typeof FIELDS)[number]["id"];
export const FIELD_IDS: readonly FieldId[] = FIELDS.map((f) => f.id);
export const fieldIndex = (id: string): number => FIELD_IDS.indexOf(id as FieldId);
export const fieldLabel = (id: string): string => FIELDS.find((f) => f.id === id)?.label ?? id;
