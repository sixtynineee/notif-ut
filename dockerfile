FROM node:22-slim

# Install Chromium, Git, dan pustaka pendukung
RUN apt-get update && apt-get install -y \
    chromium \
    git \
    libnss3 \
    libfreetype6 \
    libharfbuzz0b \
    ca-certificates \
    fonts-freefont-ttf \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Konfigurasi Puppeteer untuk menggunakan Chromium sistem
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Menjalankan server.js dari folder notif-ut-backend
CMD ["node", "notif-ut-backend/server.js"]
