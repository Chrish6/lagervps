# ─── Lager — Docker-image ─────────────────────────────────────────────────────
# Bas: Node 20. Byggverktyg (python3/make/g++) behövs för att kompilera
# sqlite3:s nativa del vid npm install — samma sak som annars kan strula vid
# en vanlig (icke-Docker) installation, se install.sh.
#
# Tvåstegsbygge: steg 1 installerar ALLA paket (inkl. vite, som behövs för
# att bygga men inte för att köra) och bygger appen. Steg 2 tar bara med det
# som faktiskt behövs för att KÖRA servern — ingen Electron/electron-builder
# (helt irrelevant i en Linux-container) följer med i slutresultatet.

FROM node:20-bookworm-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# Körs INNAN bygget — misslyckas testerna avbryts hela Docker-bygget här,
# och den gamla, redan körande containern påverkas inte alls (Docker byter
# bara ut den när den NYA imagen är helt klar och giltig).
RUN npm test
RUN npm run build

FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
COPY server.cjs ./
COPY restore.cjs ./

EXPOSE 3000

# Kör direkt med node — Dockers egen restart-policy (se docker-compose.yml)
# ersätter PM2:s jobb här, ingen processhanterare behövs inuti containern.
CMD ["node", "server.cjs"]
