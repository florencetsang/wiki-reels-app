import { type ReactNode, useEffect } from "react";

export function Sheet(props: { title: string; onClose(): void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);
  return (
    <div className="sheet-backdrop" onClick={props.onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={props.title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" aria-hidden />
        <h3>{props.title}</h3>
        {props.children}
      </div>
    </div>
  );
}

export function ZoomViewer(props: { url: string; alt: string; onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);
  return (
    <div className="zoom" role="dialog" aria-modal="true" aria-label="Zoomed infographic">
      <button className="zoom-close" onClick={props.onClose} aria-label="Close zoom">
        ✕
      </button>
      <div className="zoom-scroll">
        <img src={props.url} alt={props.alt} />
      </div>
    </div>
  );
}
