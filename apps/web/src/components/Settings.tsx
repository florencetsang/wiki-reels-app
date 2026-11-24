import { FIELDS } from "@wiki-reels/shared/fields";
import type { ProfileResponse } from "@wiki-reels/shared";
import { useState } from "react";
import { api } from "../api.ts";
import type { LocalPrefs } from "../prefs.ts";
import { FieldPicker } from "./FieldPicker.tsx";
import { Sheet } from "./Sheet.tsx";

interface Props {
  profile: ProfileResponse | null;
  prefs: LocalPrefs;
  setPrefs(p: Partial<LocalPrefs>): void;
  /** Called after any change that invalidates the feed; reload the profile and restart feeds. */
  onProfileChanged(): void;
  toast(msg: string): void;
}

export function Settings(props: Props) {
  const { profile, prefs } = props;
  const [editing, setEditing] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const hidden = new Set(profile?.hiddenFields ?? []);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      props.onProfileChanged();
      props.toast(done);
    } catch {
      props.toast("Something went wrong. Try again.");
    }
  };

  const toggleHidden = (id: string) => {
    const next = hidden.has(id) ? [...hidden].filter((f) => f !== id) : [...hidden, id];
    void run(() => api.setHidden(next), hidden.has(id) ? "Topic shown again" : "Topic hidden");
  };

  const interest = profile?.fieldInterest ?? {};
  const ranked = [...FIELDS].sort((a, b) => (interest[b.id] ?? 0) - (interest[a.id] ?? 0));

  return (
    <main className="page-screen">
      <h1>You</h1>

      <section className="card">
        <h2>What we think you like</h2>
        <p className="fine">Based on {profile?.interactions ?? 0} reels. This is all we use to pick your feed.</p>
        <ul className="bars">
          {ranked.map((f) => (
            <li key={f.id} className={hidden.has(f.id) ? "muted" : ""}>
              <span>
                {f.emoji} {f.label}
              </span>
              <span className="meter">
                <span style={{ width: `${Math.round((interest[f.id] ?? 0) * 100)}%` }} />
              </span>
            </li>
          ))}
        </ul>
        <button className="primary wide" onClick={() => setEditing(true)}>
          Change my topics
        </button>
      </section>

      <section className="card">
        <h2>Hidden topics</h2>
        <p className="fine">Hidden topics never appear in your feed.</p>
        <div className="chips">
          {FIELDS.map((f) => (
            <button key={f.id} className={hidden.has(f.id) ? "chip on" : "chip"} aria-pressed={hidden.has(f.id)} onClick={() => toggleHidden(f.id)}>
              {hidden.has(f.id) ? "🚫 " : ""}
              {f.label}
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Viewing</h2>
        <label className="toggle">
          <input type="checkbox" checked={prefs.dataSaver} onChange={(e) => props.setPrefs({ dataSaver: e.target.checked })} />
          <span>
            Data saver
            <small>Don't preload upcoming reels</small>
          </span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={prefs.reduceMotion} onChange={(e) => props.setPrefs({ reduceMotion: e.target.checked })} />
          <span>
            Reduce motion
            <small>No smooth scrolling or animations</small>
          </span>
        </label>
      </section>

      <section className="card">
        <h2>Recommendations</h2>
        {profile?.canUndoReset && (
          <button className="ghost wide" onClick={() => void run(() => api.reset("undo"), "Restored your previous recommendations")}>
            ↩ Undo last reset
          </button>
        )}
        <button className="danger wide" onClick={() => setConfirmReset(true)}>
          Reset my recommendations
        </button>
        <button className="ghost wide" disabled title="Coming soon">
          Sign in to sync across devices (coming soon)
        </button>
      </section>

      <p className="fine about">
        Reels are generated from Wikipedia articles and are available under{" "}
        <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener">
          CC BY-SA 4.0
        </a>
        . Wiki Reels is not affiliated with the Wikimedia Foundation.
      </p>

      {editing && (
        <Sheet title="Pick your topics" onClose={() => setEditing(false)}>
          <p className="fine">Your feed shifts to these right away. What you've watched is kept, but counts for less.</p>
          <FieldPicker
            initial={profile?.chosenFields}
            submitLabel="Update my feed"
            onSubmit={(fields) => {
              setEditing(false);
              void run(() => api.reset("soft", fields), "Feed updated");
            }}
          />
        </Sheet>
      )}
      {confirmReset && (
        <Sheet title="Reset recommendations?" onClose={() => setConfirmReset(false)}>
          <p>We'll forget what you've liked and start fresh with new topics. You can undo this for 7 days.</p>
          <button
            className="danger wide"
            onClick={() => {
              setConfirmReset(false);
              void run(() => api.reset("hard"), "Recommendations reset");
            }}
          >
            Reset
          </button>
          <button className="ghost wide" onClick={() => setConfirmReset(false)}>
            Cancel
          </button>
        </Sheet>
      )}
    </main>
  );
}
