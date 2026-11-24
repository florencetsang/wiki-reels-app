import { FIELDS } from "@wiki-reels/shared/fields";
import type { ProfileResponse } from "@wiki-reels/shared";
import { FIELD_HUES } from "../reasons.ts";

export function Explore(props: { profile: ProfileResponse | null; onOpen(field: string): void }) {
  const interest = props.profile?.fieldInterest ?? {};
  const hidden = new Set(props.profile?.hiddenFields ?? []);
  return (
    <main className="page-screen">
      <h1>Explore</h1>
      <p className="lead">Dive into one topic. Your feed still learns from what you watch here.</p>
      <ul className="field-grid">
        {FIELDS.filter((f) => !hidden.has(f.id)).map((f) => (
          <li key={f.id}>
            <button className="field-tile" style={{ ["--hue" as string]: FIELD_HUES[f.id] }} onClick={() => props.onOpen(f.id)}>
              <span className="field-emoji" aria-hidden>
                {f.emoji}
              </span>
              <span>{f.label}</span>
              <span className="meter" aria-label={`Your interest ${Math.round((interest[f.id] ?? 0.5) * 100)}%`}>
                <span style={{ width: `${Math.round((interest[f.id] ?? 0.5) * 100)}%` }} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
