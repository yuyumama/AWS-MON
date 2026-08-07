# apps/api の本番コンテナイメージ。
# Lambda Web Adapter を同梱することで、普通のNode WebサーバをそのままLambdaで動かす。
#
# npm workspaces のため、ビルドコンテキストは**リポジトリルート**:
#   docker build -f apps/api/Dockerfile .
# 事前に `npm run build -w @aws-mon/shared -w @aws-mon/api` で dist/ を生成しておくこと。

# 本番依存のみをworkspacesレイアウトで解決する(lockfileはルートにのみ存在する)。
# `npm ci -w` はworkspace配下依存の解決が不完全なため、全workspaceの本番依存を入れる
# (lockfileが全workspaceのpackage.jsonを前提とするため、webの分もコピーが必要)
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci --omit=dev

FROM node:20-slim

# Lambda Web Adapter をコピーするだけでLambda対応になる（アプリ側の改修は不要）。
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 /lambda-adapter /opt/extensions/lambda-adapter

WORKDIR /app
# workspacesレイアウトごとコピーする(hoistされない依存は apps/api/node_modules に入る)
COPY --from=deps /app ./
COPY packages/shared/dist packages/shared/dist
COPY apps/api/dist apps/api/dist

# 非rootで実行（コンテナエスケープ対策。LWA/Lambdaはroot権限を必要としない）
USER node

# LWA が待ち受けるポート
ENV PORT=8080
ENV AWS_LWA_PORT=8080

# デプロイ後スモークが版を突き合わせるための git SHA。GET /health が返す。
# レイヤキャッシュを壊さないよう、COPY より後(最終行の直前)に置く。
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}

CMD ["node", "apps/api/dist/index.js"]
