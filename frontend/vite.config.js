var _a;
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
var target = (_a = process.env.API_TARGET) !== null && _a !== void 0 ? _a : "http://localhost:8010";
// Vite's dev server treats /ui/.../jo@corp.com (a person's page) as a missing file because of the
// dot. Hand such paths to the SPA shell; real file types and Vite's own URLs are left alone.
var FILE_TYPES = /\.(?:[cm]?[jt]sx?|css|scss|map|json|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|txt|webmanifest|wasm|mp4|webm|glb|gltf|hdr|bin|html)$/i;
var spaDottedRoutes = {
    name: "spa-dotted-routes",
    configureServer: function (server) {
        server.middlewares.use(function (req, _res, next) {
            var _a, _b;
            var url = (_a = req.url) !== null && _a !== void 0 ? _a : "";
            var path = url.split("?")[0];
            var last = (_b = path.split("/").pop()) !== null && _b !== void 0 ? _b : "";
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
