import { FIELDS } from "@wiki-reels/shared/fields";
import { useState } from "react";
import { FIELD_HUES } from "../reasons.ts";

interface Props {
  initial?: string[];
  submitLabel: string;
  busy?: boolean;
  onSubmit(fields: string[]): void;
  onSurprise?(): void;
}

export function FieldPicker(props: Props) {
  const [picked, setPicked] = useState<string[]>(props.initial ?? []);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <div className="picker">
      <ul className="field-grid" role="group" aria-label="Topics">
        {FIELDS.map((f) => {
          const on = picked.includes(f.id);
          return (
            <li key={f.id}>
              <button
                className={on ? "field-tile on" : "field-tile"}
                aria-pressed={on}
                style={{ ["--hue" as string]: FIELD_HUES[f.id] }}
                onClick={() => toggle(f.id)}
              >
                <span className="field-emoji" aria-hidden>
                  {f.emoji}
                </span>
                <span>{f.label}</span>
                {on && (
                  <span className="check" aria-hidden>
                    ✓
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="hint">{picked.length < 3 ? `Pick at least 3 (${picked.length} chosen)` : `${picked.length} chosen`}</p>
      <button className="primary wide" disabled={picked.length < 3 || props.busy} onClick={() => props.onSubmit(picked)}>
        {props.submitLabel}
      </button>
      {props.onSurprise && (
        <button className="ghost wide" disabled={props.busy} onClick={props.onSurprise}>
          🎲 Surprise me
        </button>
      )}
    </div>
  );
}
