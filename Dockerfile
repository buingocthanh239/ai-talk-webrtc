# syntax=docker/dockerfile:1

# Node 24: chay thang file .ts (type stripping mac dinh) va co node:sqlite
# khong can co --experimental. Doi image xuong Node 22 la ca hai thu do vo hieu
# — vi vay ca ba stage dung chung mot ARG, sua mot cho la sua het.
ARG NODE_IMAGE=node:24-alpine

# ---------------------------------------------------------------- build
# Stage nay chi ton tai de chay esbuild ra public/js. Server khong qua day.
FROM ${NODE_IMAGE} AS build
WORKDIR /app

COPY package.json package-lock.json ./
# --include=dev vi esbuild nam trong devDependencies. Cache mount giu lai
# tarball da tai, nen doi lock file chi phai tai phan chenh lech.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev --no-audit --no-fund

COPY build.js ./
COPY shared ./shared
COPY public ./public
RUN node build.js

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

# Runtime khong can node_modules: dependency duy nhat (spine-webgl) la code
# client, da bi esbuild gop het vao public/js. Copy package.json vao chi de
# Node doc "type": "module".
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY public ./public

# server/index.ts phuc vu /character/* tu thu muc nay (asset Spine ~10mb,
# de ngoai public/ vi chung nang). Thieu no thi trang van chay nhung avatar
# 404 — loi chi lo ra tren production.
COPY character ./character

COPY --from=build /app/public/js ./public/js

# db.ts goi mkdirSync(AUDIO_DIR) luc import, nen thu muc phai ghi duoc boi user
# `node`. Tao san o day de volume mount vao cung dung chu so huu.
RUN install -d -o node -g node /app/data /app/data/audio

USER node

# Giu VOLUME du compose da khai bao appdata: `docker run` tran khong co no la
# mat sqlite + audio moi lan xoa container.
VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/lessons').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Khong dung `npm start`: script do chay lai build.js va doc .env — trong
# container thi bundle da co san, con bien moi truong do Docker bom vao.
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.ts"]
