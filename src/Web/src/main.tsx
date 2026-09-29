import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import Workspace from "./features/workspace/Workspace";
import { ThemeProvider } from "./features/theme/ThemeProvider";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <Workspace />
    </ThemeProvider>
  </StrictMode>,
);
