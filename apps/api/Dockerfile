# apps/api の本番コンテナイメージ。
# Lambda Web Adapter を同梱することで、普通のNode WebサーバをそのままLambdaで動かす。
# （事前に `npm run build` で dist/ を生成しておくこと）
FROM node:20-slim

# Lambda Web Adapter をコピーするだけでLambda対応になる（アプリ側の改修は不要）。
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 /lambda-adapter /opt/extensions/lambda-adapter

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist

# LWA が待ち受けるポート
ENV PORT=8080
ENV AWS_LWA_PORT=8080

CMD ["node", "dist/index.js"]
