# ---- build the SPA ----
FROM node:20-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Same steps as `npm run build`, but into dist/ inside this image instead of
# ../app/static (that path is only for running the backend on the host).
RUN npx tsc -b && npx vite build --outDir dist --emptyOutDir

# ---- serve it ----
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
# vite.config.ts builds with base "/ui/", so the files live under /ui/.
COPY --from=build /src/dist /usr/share/nginx/html/ui
EXPOSE 80
