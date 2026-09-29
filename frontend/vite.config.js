import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Builds into app/static so the FastAPI app can keep serving the SPA as
// static files at /ui/, with no separate Node server needed in production.
// `npm run dev` instead proxies API calls to the FastAPI dev server on 8010.
export default defineConfig({
    plugins: [react()],
    base: "/ui/",
    server: {
        port: 5173,
        proxy: {
            "/auth": "http://localhost:8010",
            "/dashboard": "http://localhost:8010",
            "/meetings": "http://localhost:8010",
            "/people": "http://localhost:8010",
            "/orgchart": "http://localhost:8010",
            "/directory": "http://localhost:8010",
            "/chat": "http://localhost:8010",
            "/attendance": "http://localhost:8010",
        },
    },
    build: {
        outDir: "../app/static",
        emptyOutDir: true,
    },
});
