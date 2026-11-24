import type { ProfileResponse } from "@wiki-reels/shared";
import { useCallback, useEffect, useState } from "react";
import { api, startSession } from "./api.ts";
import { Explore } from "./components/Explore.tsx";
import { Feed } from "./components/Feed.tsx";
import { Library } from "./components/Library.tsx";
import { Onboarding } from "./components/Onboarding.tsx";
import { Settings } from "./components/Settings.tsx";
import { prefersReducedMotion, useLocalPrefs } from "./prefs.ts";

type Tab = "feed" | "explore" | "library" | "you";
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "feed", label: "For you", icon: "▶" },
  { id: "explore", label: "Explore", icon: "🧭" },
  { id: "library", label: "Library", icon: "🔖" },
  { id: "you", label: "You", icon: "☺" },
];

export function App() {
  const [status, setStatus] = useState<"loading" | "onboarding" | "ready" | "offline">("loading");
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [tab, setTab] = useState<Tab>("feed");
  const [topic, setTopic] = useState<string | null>(null);
  // Bumped when the profile changes in a way that invalidates queued reels.
  const [feedKey, setFeedKey] = useState(0);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [prefs, setPrefs] = useLocalPrefs();
  const reducedMotion = prefersReducedMotion(prefs);

  const toast = useCallback((msg: string) => setToastMsg(msg), []);
  useEffect(() => {
    if (!toastMsg) return;
    const t = window.setTimeout(() => setToastMsg(null), 2600);
    return () => window.clearTimeout(t);
  }, [toastMsg]);

  const boot = useCallback(async () => {
    try {
      const session = await startSession();
      setStatus(session.onboarded ? "ready" : "onboarding");
      setProfile(await api.profile());
    } catch {
      setStatus("offline");
    }
  }, []);
  useEffect(() => void boot(), [boot]);

  const refreshProfile = useCallback(async () => {
    const p = await api.profile().catch(() => null);
    if (p) {
      setProfile(p);
      if (!p.onboarded) setStatus("onboarding");
    }
    setFeedKey((k) => k + 1);
    setTopic(null);
  }, []);

  useEffect(() => {
    if (status !== "ready" || (tab !== "feed" && tab !== "explore")) return;
    void api.profile().then(setProfile, () => undefined);
  }, [tab, status]);

  const openField = (field: string) => {
    setTopic(field);
    setTab("explore");
  };

  let body: React.ReactNode;
  if (status === "loading") body = <div className="empty"><div className="spinner" aria-label="Loading" /></div>;
  else if (status === "offline")
    body = (
      <div className="empty">
        <p>You're offline, or Wiki Reels can't be reached.</p>
        <button className="primary" onClick={() => void boot()}>
          Try again
        </button>
      </div>
    );
  else if (status === "onboarding")
    body = (
      <Onboarding
        toast={toast}
        onDone={() => {
          setStatus("ready");
          setTab("feed");
          void refreshProfile();
        }}
      />
    );
  else
    body = (
      <>
        <Feed
          key={`feed-${feedKey}`}
          active={tab === "feed"}
          dataSaver={prefs.dataSaver}
          reducedMotion={reducedMotion}
          onOpenField={openField}
          toast={toast}
        />
        {tab === "explore" &&
          (topic ? (
            <Feed
              key={`topic-${topic}-${feedKey}`}
              field={topic}
              active
              dataSaver={prefs.dataSaver}
              reducedMotion={reducedMotion}
              onOpenField={openField}
              onBack={() => setTopic(null)}
              toast={toast}
            />
          ) : (
            <Explore profile={profile} onOpen={setTopic} />
          ))}
        {tab === "library" && <Library active />}
        {tab === "you" && (
          <Settings profile={profile} prefs={prefs} setPrefs={setPrefs} onProfileChanged={() => void refreshProfile()} toast={toast} />
        )}
        <nav className="tabbar" aria-label="Main">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "on" : ""}
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => {
                if (t.id === "explore" && tab === "explore") setTopic(null);
                setTab(t.id);
              }}
            >
              <span aria-hidden>{t.icon}</span>
              {t.label}
            </button>
          ))}
        </nav>
      </>
    );

  return (
    <div className={reducedMotion ? "app reduce-motion" : "app"}>
      {body}
      {toastMsg && (
        <div className="toast" role="status">
          {toastMsg}
        </div>
      )}
    </div>
  );
}
