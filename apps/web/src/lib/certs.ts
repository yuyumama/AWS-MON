// 資格・ドメイン・出題モードの表示用定義。
// 正式名称とAIP-C01ドメインは apps/agent/quiz_agent/certs.py と対応させる。
import type { SessionMode } from "@aws-mon/shared";

export type CertOption = { code: string; name: string };

export const certOptions: CertOption[] = [
	{ code: "clf", name: "AWS Certified Cloud Practitioner (CLF-C02)" },
	{ code: "aif", name: "AWS Certified AI Practitioner (AIF-C01)" },
	{
		code: "saa",
		name: "AWS Certified Solutions Architect - Associate (SAA-C03)",
	},
	{ code: "dva", name: "AWS Certified Developer - Associate (DVA-C02)" },
	{
		code: "soa",
		name: "AWS Certified CloudOps Engineer - Associate (SOA-C03)",
	},
	{ code: "dea", name: "AWS Certified Data Engineer - Associate (DEA-C01)" },
	{
		code: "mla",
		name: "AWS Certified Machine Learning Engineer - Associate (MLA-C01)",
	},
	{
		code: "sap",
		name: "AWS Certified Solutions Architect - Professional (SAP-C02)",
	},
	{
		code: "dop",
		name: "AWS Certified DevOps Engineer - Professional (DOP-C02)",
	},
	{
		code: "aip",
		name: "AWS Certified Generative AI Developer - Professional (AIP-C01)",
	},
	{
		code: "ans",
		name: "AWS Certified Advanced Networking - Specialty (ANS-C01)",
	},
	{ code: "scs", name: "AWS Certified Security - Specialty (SCS-C02)" },
];

export function certName(code: string): string {
	return certOptions.find((c) => c.code === code)?.name ?? code;
}

export type DomainOption = { value: string; label: string; weight?: number };

// AIP-C01 のみドメイン別出題に対応(公式試験ガイドの重み)
export const aipDomains: DomainOption[] = [
	{ value: "all", label: "全ドメイン(重み付きランダム)" },
	{
		value: "d1",
		label: "基盤モデル統合・データ管理・コンプライアンス",
		weight: 31,
	},
	{ value: "d2", label: "実装と統合", weight: 26 },
	{ value: "d3", label: "AIの安全性・セキュリティ・ガバナンス", weight: 20 },
	{ value: "d4", label: "運用効率と最適化", weight: 12 },
	{ value: "d5", label: "テスト・検証・トラブルシューティング", weight: 11 },
];

export function domainLabel(domain: string): string {
	if (domain === "general") return "全般";
	return aipDomains.find((d) => d.value === domain)?.label ?? domain;
}

export type ModeOption = {
	value: SessionMode;
	label: string;
	description: string;
};

export const modeOptions: ModeOption[] = [
	{
		value: "BANK",
		label: "問題バンク",
		description: "保存済みの問題から出題。生成なしで即開始できる。",
	},
	{
		value: "MIXED",
		label: "ミックス",
		description: "バンクを優先し、候補が尽きたときだけ新規生成する。",
	},
	{
		value: "GENERATE",
		label: "新規生成",
		description: "毎問AIが生成する。agentの起動が必要で、出題に時間がかかる。",
	},
];

export function modeLabel(mode: string): string {
	return modeOptions.find((m) => m.value === mode)?.label ?? mode;
}
