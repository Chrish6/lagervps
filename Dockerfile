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
# npm ci (inte npm install) — installerar EXAKT de versioner som står i
# package-lock.json, inget annat. Förutsägbart, samma resultat varje gång,
# istället för att npm install kan välja nyare kompatibla versioner som
# aldrig testats.
RUN npm ci
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
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY server.cjs ./
COPY restore.cjs ./

# SÄKERHET: kör INTE som root inuti containern. UID 1000 är standard för
# den första vanliga användaren på de flesta Linux-system (matchar
# ./data-mappens ägare på VPS:en, satt automatiskt av update.sh/install.sh).
# Node-baserade images HAR OFTA redan en färdig användare med exakt UID
# 1000 (brukar heta "node") — kollar därför om den finns innan en ny
# skapas, annars skulle bygget krascha på en UID-krock. Använder sedan
# UID:et direkt (inte ett namn) i USER-raden, så det fungerar oavsett vad
# användaren råkar heta i just den här bas-imagen.
RUN if ! id -u 1000 >/dev/null 2>&1; then \
      groupadd -g 1000 lager && useradd -u 1000 -g 1000 -s /bin/false -M lager; \
    fi \
    && chown -R 1000:1000 /app
USER 1000

EXPOSE 3000

# Kör direkt med node — Dockers egen restart-policy (se docker-compose.yml)
# ersätter PM2:s jobb här, ingen processhanterare behövs inuti containern.
CMD ["node", "server.cjs"]
