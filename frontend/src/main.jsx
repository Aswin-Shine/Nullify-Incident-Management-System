import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/commit-mono/400.css";
import "@fontsource/commit-mono/500.css";
import "./index.css";
import App from "./App.jsx";
import { applyTheme, getThemePref } from "./theme";

// Before the first render, so a saved Light/Dark choice never flashes the other one.
applyTheme(getThemePref());

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
