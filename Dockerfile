# syntax=docker/dockerfile:1

# Node 24: chay thang file .ts (type stripping mac dinh) va co node:sqlite
# khong can co --experimental. Doi image xuong Node 22 la ca hai thu do vo hieu.

# ---------------------------------------------------------------- build
# Stage nay chi ton tai de chay esbuild ra public/js. Server khong qua day.
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY build.js ./
COPY shared ./shared
COPY public ./public
RUN node build.js

# ---------------------------------------------------------------- runtime
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

# package.json khong co "dependencies" nao, nen runtime khong can node_modules.
# Copy no vao chi de Node doc "type": "module".
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY public ./public
COPY --from=build /app/public/js ./public/js

# db.ts goi mkdirSync(AUDIO_DIR) luc import, nen thu muc phai ghi duoc boi user
# `node`. Tao san o day de volume mount vao cung dung chu so huu.
RUN mkdir -p /app/data/audio && chown -R node:node /app/data

USER node
VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/lessons').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Khong dung `npm start`: script do chay lai build.js va doc .env — trong
# container thi bundle da co san, con bien moi truong do Docker bom vao.
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.ts"]
