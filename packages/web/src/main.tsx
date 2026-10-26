import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { initializeAuth } from "./auth.ts";
import "./styles.css";

initializeAuth();

const container = document.getElementById("root");
if (!container) {
	throw new Error("缺少 #root 挂载点");
}

createRoot(container).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
