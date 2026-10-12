import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds into app/static so the FastAPI app can keep serving the SPA as
// static files at /ui/, with no separate Node server needed in production.
// `npm run dev` instead proxies API calls to the FastAPI dev server on 8010.
// API_TARGET lets a local backend (e.g. http://localhost:8011) stand in for the Docker one on :8010.
declare const process: { env: Record<string, string | undefined> }; // Node global; avoids needing @types/node
const target = process.env.API_TARGET ?? "http://localhost:8010";

// Vite's dev server treats /ui/.../jo@corp.com (a person's page) as a missing file because of the
// dot. Hand such paths to the SPA shell; real file types and Vite's own URLs are left alone.
const FILE_TYPES = /\.(?:[cm]?[jt]sx?|css|scss|map|json|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|txt|webmanifest|wasm|mp4|webm|glb|gltf|hdr|bin|html)$/i;
const spaDottedRoutes = {
  name: "spa-dotted-routes",
  configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: unknown, next: () => void) => void) => void } }) {
    server.middlewares.use((req, _res, next) => {
      const url = req.url ?? "";
      const path = url.split("?")[0];
      const last = path.split("/").pop() ?? "";
      if (path.indexOf("/ui/") === 0 && last.indexOf(".") >= 0 && !FILE_TYPES.test(last) && !/\/(?:src|node_modules|@[^/]+)\//.test(path)) {
        req.url = "/ui/index.html";
      }
      next();
    });
  },
};

export default defineConfig({
  plugins: [react(), spaDottedRoutes],
  base: "/ui/",
  server: {
    port: 5173,
    proxy: {
      "/auth": target,
      "/dashboard": target,
      "/meetings": target,
      "/people": target,
      "/orgchart": target,
      "/directory": target,
      "/chat": target,
      "/attendance": target,
      "/compliance": target,
      // Matches only paths starting /settings; the SPA route is /ui/settings.
      "/settings": target,
    },
  },
  build: {
    outDir: "../app/static",
    emptyOutDir: true,
  },
});
