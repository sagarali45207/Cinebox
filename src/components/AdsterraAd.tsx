
import { useEffect, useRef } from "react";

declare global {
  interface Window {
    atOptions?: {
      key: string;
      format: string;
      height: number;
      width: number;
      params: Record<string, unknown>;
    };
  }
}

export default function AdsterraAd() {
  const adContainer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = adContainer.current;
    if (!container) return;

    // Prevent duplicate injection into this ad slot.
    if (container.dataset.loaded === "true") return;

    container.dataset.loaded = "true";

    window.atOptions = {
      key: "a9cbb8407d5d4751c55409ccaa432fa2",
      format: "iframe",
      height: 250,
      width: 300,
      params: {},
    };

    const script = document.createElement("script");
    script.src =
      "https://bancadeltempoidea.org/22/a9cbb8407d5d4751c55409ccaa432fa2";
    script.type = "text/javascript";

    container.appendChild(script);

    return () => {
      script.remove();
      container.replaceChildren();
      container.dataset.loaded = "false";
    };
  }, []);

  return (
    <div
      ref={adContainer}
      className="adsterra-container"
      style={{
        width: "100%",
        minHeight: "250px",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        overflow: "hidden",
        margin: "16px auto",
      }}
    />
  );
}
