import { createHash } from "node:crypto";
import {
	bankKeys,
	hashKeys,
	type QuestionItem,
	type QuizItem,
	questionListKeys,
	randomSort,
	resolveTableNames,
	staleDaysForCert,
	staleKeys,
} from "@aws-mon/shared";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const endpoint = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";
const region = process.env.AWS_REGION ?? "us-east-1";
const tableNames = resolveTableNames();

const client = DynamoDBDocumentClient.from(
	new DynamoDBClient({
		endpoint,
		region,
		credentials: {
			accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
			secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
		},
	}),
);

const fixtures: Array<{
	cert: "aip" | "saa";
	domain: string;
	domainSelection: string;
	quiz: QuizItem;
}> = [
	{
		cert: "aip",
		domain: "d1",
		domainSelection: "all",
		quiz: {
			question: {
				type: "single",
				question:
					"Amazon Bedrock の Knowledge Bases を使う主な目的として最も適切なものはどれですか。",
				options: [
					{
						label: "A",
						text: "基盤モデルを事前学習から独自に作成する",
					},
					{
						label: "B",
						text: "外部データを検索して回答生成に利用する RAG を構成する",
					},
					{
						label: "C",
						text: "Lambda 関数の同時実行数を自動で増やす",
					},
					{
						label: "D",
						text: "CloudWatch Logs の保持期間を管理する",
					},
				],
				correct: ["B"],
			},
			explanation: {
				overview:
					"Knowledge Bases for Amazon Bedrock は、社内文書などの外部データを検索し、基盤モデルの回答に根拠として渡す RAG 構成を支援します。",
				correct_reason:
					"選択肢Bは、ベクトル検索などで関連情報を取得して回答生成に使う Knowledge Bases の用途を表しています。",
				option_reasons: [
					{
						label: "A",
						reason:
							"Bedrock は基盤モデルの利用やカスタマイズを支援しますが、Knowledge Bases は事前学習の仕組みではありません。",
					},
					{
						label: "B",
						reason:
							"外部データを検索し、取得した文脈を回答生成に利用する RAG の構成に該当します。",
					},
					{
						label: "C",
						reason:
							"Lambda の同時実行数管理は AWS Lambda の運用設定であり、Knowledge Bases の役割ではありません。",
					},
					{
						label: "D",
						reason:
							"CloudWatch Logs の保持期間管理はログ運用の設定であり、Knowledge Bases の用途ではありません。",
					},
				],
				source:
					"https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base.html",
			},
		},
	},
	{
		cert: "saa",
		domain: "general",
		domainSelection: "all",
		quiz: {
			question: {
				type: "single",
				question:
					"高可用性を確保するために、Application Load Balancer の背後に EC2 インスタンスを配置する際の基本的な設計はどれですか。",
				options: [
					{
						label: "A",
						text: "単一のアベイラビリティーゾーンにすべてのインスタンスを配置する",
					},
					{
						label: "B",
						text: "複数のアベイラビリティーゾーンにインスタンスを分散する",
					},
					{
						label: "C",
						text: "すべての通信を 1 台の NAT Gateway に集約する",
					},
					{
						label: "D",
						text: "Auto Scaling を無効化し、固定台数だけで運用する",
					},
				],
				correct: ["B"],
			},
			explanation: {
				overview:
					"複数のアベイラビリティーゾーンにリソースを分散することで、単一 AZ 障害時の可用性を高められます。",
				correct_reason:
					"Application Load Balancer は複数 AZ のターゲットへトラフィックを分散できるため、選択肢Bが最も適切です。",
				option_reasons: [
					{
						label: "A",
						reason:
							"単一 AZ 構成は、その AZ に障害が起きた場合にサービス影響を受けやすくなります。",
					},
					{
						label: "B",
						reason: "複数 AZ へ分散することで、AZ 障害への耐性を高められます。",
					},
					{
						label: "C",
						reason:
							"NAT Gateway はプライベートサブネットから外向き通信を行うためのもので、ALB 背後の EC2 高可用性設計の主眼ではありません。",
					},
					{
						label: "D",
						reason:
							"Auto Scaling を無効化すると、需要変化や障害時の自動復旧能力が下がります。",
					},
				],
				source:
					"https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html",
			},
		},
	},
];

function addDays(date: Date, days: number): Date {
	const next = new Date(date);
	next.setUTCDate(next.getUTCDate() + days);
	return next;
}

function hashQuiz(quiz: QuizItem): string {
	return createHash("sha256")
		.update(JSON.stringify(quiz.question))
		.digest("hex");
}

function toQuestionItem(
	fixture: (typeof fixtures)[number],
	index: number,
): QuestionItem {
	const now = new Date("2026-07-01T00:00:00.000Z");
	const createdAt = now.toISOString();
	const validUntil = addDays(now, staleDaysForCert(fixture.cert)).toISOString();
	const questionId = `q_seed_${String(index + 1).padStart(3, "0")}`;
	const contentHash = hashQuiz(fixture.quiz);
	const sort = randomSort((index + 1) / 10);
	const bank = bankKeys({
		cert: fixture.cert,
		domain: fixture.domain,
		questionId,
		randomSort: sort,
	});
	const stale = staleKeys({ questionId, validUntil });
	const contentHashKeys = hashKeys(contentHash, questionId);
	const listKeys = questionListKeys({
		createdAt,
		questionId,
	});

	return {
		questionId,
		schemaVersion: 1,
		status: "ACTIVE",
		cert: fixture.cert,
		domain: fixture.domain,
		domainSelection: fixture.domainSelection,
		type: fixture.quiz.question.type,
		question: fixture.quiz.question.question,
		options: fixture.quiz.question.options,
		correct: fixture.quiz.question.correct,
		explanation: fixture.quiz.explanation,
		sourceRefs: [
			{
				url: fixture.quiz.explanation.source,
				retrievedAt: createdAt,
			},
		],
		generation: {
			modelId: "fixture",
			promptVersion: "fixture-v1",
			generatedAt: createdAt,
		},
		quality: {
			inlineGate: "not_run",
			evaluator: "none",
		},
		contentHash,
		validUntil,
		randomSort: sort,
		...bank,
		...stale,
		...contentHashKeys,
		...listKeys,
		createdAt,
		updatedAt: createdAt,
	};
}

async function seedQuestions() {
	console.log(`DynamoDB endpoint: ${endpoint}`);
	console.log(`Questions table: ${tableNames.questions}`);

	for (const [index, fixture] of fixtures.entries()) {
		const item = toQuestionItem(fixture, index);
		await client.send(
			new PutCommand({
				TableName: tableNames.questions,
				Item: item,
			}),
		);
		console.log(`put ${item.questionId} (${item.cert}/${item.domain})`);
	}

	console.log("seed complete");
}

seedQuestions().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
