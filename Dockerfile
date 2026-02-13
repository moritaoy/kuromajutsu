FROM node:22-slim

WORKDIR /app

# 依存関係のインストール（キャッシュ活用）
COPY package.json package-lock.json* ./
RUN npm install

# ソースコードをコピー
COPY . .

# ダッシュボード UI ポート
EXPOSE 9696

# 開発モードで起動
CMD ["npm", "run", "dev"]
