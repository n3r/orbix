import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@orbix/ui/src/tokens.css";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="p-8 text-[var(--text)]">Orbix SPA scaffold OK</div>
  </StrictMode>,
);
