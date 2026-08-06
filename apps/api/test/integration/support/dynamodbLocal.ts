import { randomUUID } from "node:crypto";
import { resolveTableNames } from "@aws-mon/shared";
import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { dynamoClient, dynamoDoc } from "../../../src/dynamo.js";

// DynamoDB Local への接続を扱うヘルパ。
//
// テーブルは infra/envs/local の terraform が作る。テストコードで CreateTable しないのは、
// prod と同じ modules/dynamodb を使うことでキースキーマ・GSI・射影設定の乖離をゼロにするため。
// (テスト専用のスキーマ定義を持つと、それ自体が prod と食い違っても誰も気づけない。)
//
// テーブルは共有されるため、各テストは一意なIDを使い、後始末を自分で行う。

export const tables = resolveTableNames();

const endpoint = process.env.DYNAMODB_LOCAL_ENDPOINT ?? "http://127.0.0.1:8000";

// CI では未起動を検知したら失敗させる(静かにスキップされるとゲートの意味が消えるため)。
// ローカルでは警告してスキップする。
const required = process.env.REQUIRE_DYNAMODB_LOCAL === "1";

async function probe(): Promise<string | undefined> {
	try {
		// DynamoDB Local は素のGETに400を返す。応答が返れば到達できている。
		await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
	} catch {
		return `DynamoDB Local に接続できない (${endpoint})。'cd local && docker compose up -d' で起動する。`;
	}

	for (const [key, name] of Object.entries(tables)) {
		try {
			await dynamoClient.send(new DescribeTableCommand({ TableName: name }));
		} catch {
			return `テーブル ${name} (${key}) が存在しない。'cd infra/envs/local && terraform init && terraform apply' で作成する。`;
		}
	}
	return undefined;
}

const unavailableReason = await probe();

if (unavailableReason && required) {
	throw new Error(
		`REQUIRE_DYNAMODB_LOCAL=1 だが統合テストを実行できない: ${unavailableReason}`,
	);
}

if (unavailableReason) {
	console.warn(`[integration] スキップ: ${unavailableReason}`);
}

export const dynamoLocalAvailable = unavailableReason === undefined;

/** 一意なID。共有テーブル上でテスト同士が干渉しないようにする。 */
export function uniqueId(prefix: string): string {
	return `${prefix}_${randomUUID()}`;
}

type TrackedKey = { table: string; key: Record<string, unknown> };

/**
 * 投入したアイテムを記録し、まとめて削除する。
 * テストが落ちても後片付けが走るよう afterEach から cleanup() を呼ぶ。
 */
export class TestItems {
	private readonly created: TrackedKey[] = [];

	/** アイテムを投入し、削除対象として記録する。 */
	async put(
		table: string,
		item: Record<string, unknown>,
		key: Record<string, unknown>,
	): Promise<void> {
		await dynamoDoc.send(new PutCommand({ TableName: table, Item: item }));
		this.created.push({ table, key });
	}

	/** プロダクションコードが書き込むアイテムを削除対象として記録する。 */
	track(table: string, key: Record<string, unknown>): void {
		this.created.push({ table, key });
	}

	async cleanup(): Promise<void> {
		await Promise.all(
			this.created.map(({ table, key }) =>
				dynamoDoc
					.send(new DeleteCommand({ TableName: table, Key: key }))
					.catch(() => undefined),
			),
		);
		this.created.length = 0;
	}
}
