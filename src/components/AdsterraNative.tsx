
import { useEffect, useRef } from "react";

const AD_SCRIPT =
  "https://bancadeltempoidea.org/21/0a51f139fbb590cde1037c62d330595f";

export default function AdsterraNative() {
  const containerRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);

  useEffect(() => {
    const container = containerRef.current;

    if (!container || initialized.current) return;

    initialized.current = true;

    const script = document.createElement("script");

    script.async = true;
    script.setAttribute("data-cfasync", "false");
    script.src = AD_SCRIPT;

    container.appendChild(script);

    return () => {
      script.remove();
    };
  }, []);

  return (
    <div className="adsterra-native-wrapper">
      <div
        ref={containerRef}
        id="container-0a51f139fbb590cde1037c62d330595f"
        className="adsterra-native-container"
      />
    </div>
  );
}
