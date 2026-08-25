FROM node:18-slim

# Install dependencies yang dibutuhkan Puppeteer & Chrome di Linux
RUN apt-get update && apt-get install -y \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    fonts-freefont-ttf \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Beritahu Puppeteer untuk menggunakan Chromium sistem
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["node", "server.js"]
