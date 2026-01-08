# Gunakan image Node.js versi terbaru yang stabil
FROM node:20-slim

# Install dependencies sistem yang diperlukan untuk kestabilan library browser (jika pakai puppeteer/playwright)
RUN apt-get update && apt-get install -y \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    librender1 \
    libxss1 \
    libxtst6 \
    ca-certificates \
    fonts-unicode-msa \
    libappindicator1 \
    nss-plugin-pem \
    lsb-release \
    xdg-utils \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Tentukan direktori kerja di dalam container
WORKDIR /app

# Salin package.json dan package-lock.json terlebih dahulu (optimasi cache)
COPY package*.json ./

# Install dependencies Node.js
RUN npm install

# Salin seluruh kode proyek ke dalam container
COPY . .

# Railway secara otomatis memberikan port via environment variable PORT
# Pastikan kode server.js kamu menggunakan process.env.PORT
EXPOSE 3000

# Jalankan aplikasi menggunakan PM2 (jika ada) atau node server.js langsung
CMD ["node", "server.js"]
