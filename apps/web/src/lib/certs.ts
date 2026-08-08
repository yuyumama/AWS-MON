// 資格・ドメイン・出題モードの表示用定義。
import {
	type CertLevel,
	certDomains,
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
		description: "毎問AIが生成する。agentの起動が必要で、出題に時間がかかる。",
	},
];

export function modeLabel(mode: string): string {
	return modeOptions.find((m) => m.value === mode)?.label ?? mode;
}
