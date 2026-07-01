import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { resolveTableNames } from "@aws-mon/shared";

// Lambda Web Adapter(LWA) は「PORTで待ち受ける普通のWebサーバ」をそのままLambda化する。
// そのため、このファイルにLambda固有の実装(handlerなど)は一切書かない。
// ローカルでも本番でも、同じサーバをそのまま起動する。
const port = Number(process.env.PORT ?? 8080);

// DYNAMODB_ENDPOINT が指定されていれば DynamoDB Local を、なければ実DynamoDB(IAMロール)を使う。
const dynamo = new DynamoDBClient({
  region: process.env.AWS_REGION ?? "us-east-1",
  ...(process.env.DYNAMODB_ENDPOINT
    ? { endpoint: process.env.DYNAMODB_ENDPOINT }
    : {}),
});

const app = new Hono();
const tableNames = resolveTableNames();

app.get("/health", (c) =>
  c.json({ status: "ok", service: "api", time: new Date().toISOString() }),
);

app.get("/health/tables", (c) =>
  c.json({ status: "ok", tables: tableNames }),
);

// ローカルインフラ(local/docker compose up -d)が起きていれば DynamoDB への接続を確認できる。
app.get("/health/dynamo", async (c) => {
  try {
    const out = await dynamo.send(new ListTablesCommand({}));
    return c.json({ status: "ok", tables: out.TableNames ?? [] });
  } catch (e) {
    return c.json({ status: "error", message: (e as Error).message }, 500);
  }
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`);
});
