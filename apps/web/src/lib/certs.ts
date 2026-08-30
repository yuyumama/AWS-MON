// 資格・ドメイン・出題モードの表示用定義。
import {
	type CertLevel,
	certDomains,
	type DifficultyOffset,
	findCert,
	findDomain,
	type SessionMode,
} from "@aws-mon/shared";

export function certName(code: string): string {
	const cert = findCert(code);
	return cert ? `${cert.examCode} ${cert.shortName}` : code;
}

export function certFullName(code: string): string {
	return findCert(code)?.fullName ?? code;
}

export function certLevel(code: string): CertLevel | undefined {
	return findCert(code)?.level;
}

export function certOptionLabel(code: string): string {
	const cert = findCert(code);
	return cert ? `${cert.examCode} ${cert.shortName} - ${cert.level}` : code;
}

export type DomainOption = { value: string; label: string; weight?: number };

/** 資格に属するドメインの選択肢。未知の資格では空になる。 */
export function domainOptionsForCert(code: string): DomainOption[] {
	return certDomains(code).map(({ value, label, weight }) => ({
		value,
		label,
		weight,
	}));
}

export function domainLabel(cert: string, domain: string): string {
	if (domain === "general") return "全般";
	return findDomain(cert, domain)?.label ?? domain;
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
		// 説明は選択中のモードのぶんだけ1行で出す(HomeView)。幅375pxの端末で
		// 折り返さない長さに収めること。現状 MIXED が最長で、これを超えない。
		description: "毎問AIが新しく生成する。出題までに時間がかかる。",
	},
];

// スライダーの目盛り。順序がそのまま左→右の並びになるので、易しい順に並べる。
// 難易度仕様は3種類しかないため3ノッチ。目盛りを増やすなら、先に
// apps/agent の _DIFFICULTY_REQUIREMENTS に対応する文面を足す必要がある。
export const difficultyOptions: {
	value: DifficultyOffset;
	label: string;
	description: string;
}[] = [
	{
		value: "EASY",
		label: "易しめ",
		description: "1つのサービスの役割と用途が分かれば解ける水準。",
	},
	{
		value: "STANDARD",
		label: "標準",
		description: "この資格のレベルどおりの水準。",
	},
	{
		value: "HARD",
		label: "難しめ",
		description: "複数サービスの制約を突き合わせて判断する水準。",
	},
];

export function difficultyLabel(difficulty: string): string {
	return (
		difficultyOptions.find((d) => d.value === difficulty)?.label ?? difficulty
	);
}

export function difficultyDescription(difficulty: string): string {
	return (
		difficultyOptions.find((d) => d.value === difficulty)?.description ?? ""
	);
}

export function modeLabel(mode: string): string {
	return modeOptions.find((m) => m.value === mode)?.label ?? mode;
}

export function modeDescription(mode: string): string {
	return modeOptions.find((m) => m.value === mode)?.description ?? "";
}
