import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import Workspace from "./features/workspace/Workspace";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Workspace />
  </StrictMode>,
);
