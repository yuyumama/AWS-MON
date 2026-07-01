import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { resolveTableNames } from "@aws-mon/shared";
import { dynamoClient } from "./dynamo.js";
import {
  asNumber,
  asObject,
  asString,
  asStringArray,
  devUserId,
  errorResponse,
} from "./http.js";
import {
  answerSession,
  getSession,
  nextSessionQuestion,
  startSession,
} from "./repository.js";
import { saveGeneratedQuestion } from "./questionRepository.js";
import { runRunnableJobs } from "./jobRepository.js";

// Lambda Web Adapter(LWA) は「PORTで待ち受ける普通のWebサーバ」をそのままLambda化する。
// そのため、このファイルにLambda固有の実装(handlerなど)は一切書かない。
// ローカルでも本番でも、同じサーバをそのまま起動する。
const port = Number(process.env.PORT ?? 8080);

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
    const out = await dynamoClient.send(new ListTablesCommand({}));
    return c.json({ status: "ok", tables: out.TableNames ?? [] });
  } catch (e) {
    return c.json({ status: "error", message: (e as Error).message }, 500);
  }
});

app.post("/sessions", async (c) => {
  try {
    const body = asObject(await c.req.json().catch(() => ({})));
    const cert = asString(body.cert) ?? "aip";
    const domainSelection = asString(body.domainSelection);
    const domain = asString(body.domain);
    const mode = asString(body.mode);

    const session = await startSession({
      userId: devUserId(c),
      cert,
      domainSelection,
      domain,
      mode: mode === "GENERATE" || mode === "MIXED" ? mode : "BANK",
    });

    return c.json({ status: "ok", session }, 201);
  } catch (e) {
    return errorResponse(c, e);
  }
});

app.get("/sessions/:sessionId", async (c) => {
  try {
    const session = await getSession({
      userId: devUserId(c),
      sessionId: c.req.param("sessionId"),
    });
    return c.json({ status: "ok", session });
  } catch (e) {
    return errorResponse(c, e);
  }
});

app.post("/sessions/:sessionId/answers", async (c) => {
  try {
    const body = asObject(await c.req.json().catch(() => ({})));
    const sequence = asNumber(body.sequence);
    if (!sequence) {
      return c.json({ status: "error", message: "sequence is required" }, 400);
    }

    const result = await answerSession({
      userId: devUserId(c),
      sessionId: c.req.param("sessionId"),
      sequence,
      selectedAnswers: asStringArray(body.selectedAnswers),
      version: asNumber(body.version),
      elapsedMs: asNumber(body.elapsedMs),
    });

    return c.json({ status: "ok", ...result });
  } catch (e) {
    return errorResponse(c, e);
  }
});

app.post("/sessions/:sessionId/next", async (c) => {
  try {
    const body = asObject(await c.req.json().catch(() => ({})));
    const session = await nextSessionQuestion({
      userId: devUserId(c),
      sessionId: c.req.param("sessionId"),
      version: asNumber(body.version),
    });

    return c.json({ status: "ok", session });
  } catch (e) {
    return errorResponse(c, e);
  }
});

app.post("/dev/questions", async (c) => {
  try {
    const body = asObject(await c.req.json().catch(() => ({})));
    const result = await saveGeneratedQuestion({
      cert: asString(body.cert) ?? "",
      domain: asString(body.domain) ?? "",
      domainSelection: asString(body.domainSelection),
      quiz: body.quiz,
      generation: body.generation,
      quality: body.quality,
      sourceRefs: body.sourceRefs,
    });

    const response = {
      status: "ok",
      created: result.created,
      deduplicated: result.deduplicated,
      questionId: result.item.questionId,
      contentHash: result.item.contentHash,
      question: result.question,
    };

    return result.created ? c.json(response, 201) : c.json(response);
  } catch (e) {
    return errorResponse(c, e);
  }
});

app.post("/dev/jobs/run", async (c) => {
  try {
    const result = await runRunnableJobs();
    return c.json({ status: "ok", ...result });
  } catch (e) {
    return errorResponse(c, e);
  }
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`);
});
