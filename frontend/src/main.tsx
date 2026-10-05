import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { Splash } from "./components/brand/Splash";
import { MotionRoot } from "./components/motion/MotionRoot";
import "./index.css";
import "./motion.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter basename="/ui" future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App />
    </BrowserRouter>
    <Splash />
    <MotionRoot />
  </React.StrictMode>
);
