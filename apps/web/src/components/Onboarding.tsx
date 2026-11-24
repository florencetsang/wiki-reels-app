import { useState } from "react";
import { api } from "../api.ts";
import { FieldPicker } from "./FieldPicker.tsx";

export function Onboarding(props: { onDone(): void; toast(msg: string): void }) {
  const [busy, setBusy] = useState(false);
  const submit = async (fields: string[]) => {
    setBusy(true);
    try {
      await api.onboard(fields);
      props.onDone();
    } catch {
      props.toast("Couldn't save your topics. Try again.");
      setBusy(false);
    }
  };
  return (
    <main className="onboarding">
      <h1>
        Learn something
        <br />
        in 60 seconds.
      </h1>
      <p className="lead">Swipeable infographic reels made from Wikipedia's most important articles. What are you curious about?</p>
      <FieldPicker submitLabel="Start watching" busy={busy} onSubmit={submit} onSurprise={() => submit([])} />
      <p className="fine">No sign-up needed. We learn what you enjoy from how you watch, on this device only.</p>
    </main>
  );
}
