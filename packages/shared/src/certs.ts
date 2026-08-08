// AWS認定試験12資格の定義（資格メタデータ + 試験ガイドのドメイン構成）。
//
// ここが定義の**正**である。apps/web の表示、apps/api のドメイン抽選、
// および apps/agent に渡すドメインラベルはすべてこの表から引く。
//
// apps/agent（Python）はこの表を読まない。docker build context が apps/agent のみで
// packages/shared がイメージから見えないため、API がラベルを HTTP で渡す設計にしている。
//
// 重みは公式HTML版試験ガイドの記載値。**試験改訂で変わるため、資格ごとに出典URLと
// 取得日を併記する**（後から再検証できるようにするため）。
// 出典の索引: https://docs.aws.amazon.com/aws-certification/latest/examguides/aws-certification-exam-guides.html

export type CertLevel =
	| "Foundational"
	| "Associate"
	| "Professional"
	| "Specialty";

export type ExamDomain = {
	/** DynamoDBキーに入る値。資格ごとに d1 から連番。 */
	value: string;
	/** 表示用の日本語ラベル。 */
	label: string;
	/** 試験ガイド原文の英語ドメイン名。生成プロンプトのグラウンディングに使う。 */
	labelEn: string;
	/** 公式試験ガイドの配点比率(%)。資格内の合計は100。 */
	weight: number;
};

export type CertDefinition = {
	/** 内部コード。DynamoDBキーに入る。 */
	code: string;
	/** 試験コード（表示用）。 */
	examCode: string;
	/** 正式名称。LLMプロンプトのグラウンディングに使うため短縮してはならない。 */
	fullName: string;
	/** 一覧・カード・selectで使う短縮表示名。 */
	shortName: string;
	level: CertLevel;
	/** 公式HTML版試験ガイドのURL。 */
	examGuideUrl: string;
	/** examGuideUrl から重みを取得した日。 */
	examGuideFetchedAt: string;
	domains: ExamDomain[];
};

/** ドメイン絞り込みを指定しないことを表す値。 */
export const allDomains = "all";

export const certDefinitions: CertDefinition[] = [
	{
		code: "clf",
		examCode: "CLF-C02",
		fullName: "AWS Certified Cloud Practitioner (CLF-C02)",
		shortName: "Cloud Practitioner",
		level: "Foundational",
		examGuideUrl:
			"https://docs.aws.amazon.com/aws-certification/latest/cloud-practitioner-02/cloud-practitioner-02.html",
		examGuideFetchedAt: "2026-08-08",
		domains: [
			{
				value: "d1",
				label: "クラウドの概念",
				labelEn: "Cloud Concepts",
				weight: 24,
			},
			{
				value: "d2",
				label: "セキュリティとコンプライアンス",
				labelEn: "Security and Compliance",
				weight: 30,
			},
			{
				value: "d3",
				label: "クラウドのテクノロジーとサービス",
				labelEn: "Cloud Technology and Services",
				weight: 34,
			},
			{
				value: "d4",
				label: "請求・料金・サポート",
				labelEn: "Billing, Pricing, and Support",
				weight: 12,
			},
		],
	},
	{
		code: "aif",
		examCode: "AIF-C01",
		fullName: "AWS Certified AI Practitioner (AIF-C01)",
		shortName: "AI Practitioner",
		level: "Foundational",
		examGuideUrl:
			"https://docs.aws.amazon.com/aws-certification/latest/ai-practitioner-01/ai-practitioner-01.html",
		examGuideFetchedAt: "2026-08-08",
		domains: [
			{
				value: "d1",
				label: "AI・MLの基礎",
				labelEn: "Fundamentals of AI and ML",
				weight: 20,
			},
			{
				value: "d2",
				label: "生成AIの基礎",
				labelEn: "Fundamentals of GenAI",
				weight: 24,
			},
			{
				value: "d3",
				label: "基盤モデルの応用",
				labelEn: "Applications of Foundation Models",
				weight: 28,
			},
			{
				value: "d4",
				label: "責任あるAIのガイドライン",
				labelEn: "Guidelines for Responsible AI",
				weight: 14,
			},
			{
				value: "d5",
				label: "AIソリューションのセキュリティ・コンプライアンス・ガバナンス",
				labelEn: "Security, Compliance, and Governance for AI Solutions",
				weight: 14,
			},
		],
	},
	{
		code: "saa",
		examCode: "SAA-C03",
		fullName: "AWS Certified Solutions Architect - Associate (SAA-C03)",
		shortName: "Solutions Architect",
		level: "Associate",
		examGuideUrl:
			"https://docs.aws.amazon.com/aws-certification/latest/solutions-architect-associate-03/solutions-architect-associate-03.html",
		examGuideFetchedAt: "2026-08-08",
		domains: [
			{
				value: "d1",
				label: "セキュアなアーキテクチャの設計",
				labelEn: "Design Secure Architectures",
				weight: 30,
			},
			{
				value: "d2",
				label: "弾力性のあるアーキテクチャの設計",
				labelEn: "Design Resilient Architectures",
				weight: 26,
			},
			{
				value: "d3",
				label: "高性能アーキテクチャの設計",
				labelEn: "Design High-Performing Architectures",
				weight: 24,
			},
			{
				value: "d4",
				label: "コスト最適化アーキテクチャの設計",
				labelEn: "Design Cost-Optimized Architectures",
				weight: 20,
			},
		],
	},
	{
		code: "dva",
		examCode: "DVA-C02",
		fullName: "AWS Certified Developer - Associate (DVA-C02)",
		shortName: "Developer",
		level: "Associate",
		examGuideUrl:
			"https://docs.aws.amazon.com/aws-certification/latest/developer-associate-02/developer-associate-02.html",
		examGuideFetchedAt: "2026-08-08",
		domains: [
			{
				value: "d1",
				label: "AWSサービスによる開発",
				labelEn: "Development with AWS Services",
				weight: 32,
			},
			{ value: "d2", label: "セキュリティ", labelEn: "Security", weight: 26 },
			{ value: "d3", label: "デプロイ", labelEn: "Deployment", weight: 24 },
			{
				value: "d4",
				label: "トラブルシューティングと最適化",
				labelEn: "Troubleshooting and Optimization",
				weight: 18,
			},
		],
	},
	{
		code: "soa",
		examCode: "SOA-C03",
		fullName: "AWS Certified CloudOps Engineer - Associate (SOA-C03)",
		shortName: "CloudOps Engineer",
		level: "Associate",
		// slug は旧名 (sysops-administrator) のまま。cloudops-engineer-associate-03 は404。
		examGuideUrl:
			"https://docs.aws.amazon.com/aws-certification/latest/sysops-administrator-associate-03/sysops-administrator-associate-03.html",
		examGuideFetchedAt: "2026-08-08",
		domains: [
			{
				value: "d1",
				label: "モニタリング・ログ・分析・修復・パフォーマンス最適化",
				labelEn:
					"Monitoring, Logging, Analysis, Remediation, and Performance Optimization",
				weight: 22,
			},
			{
				value: "d2",
				label: "信頼性と事業継続",
				labelEn: "Reliability and Business Continuity",
				weight: 22,
			},
			{
				value: "d3",
				label: "デプロイ・プロビジョニング・自動化",
				labelEn: "Deployment, Provisioning, and Automation",
				weight: 22,
			},
			{
				value: "d4",
				label: "セキュリティとコンプライアンス",
				labelEn: "Security and Compliance",
				weight: 16,
			},
			{
				value: "d5",
				label: "ネットワークとコンテンツ配信",
				labelEn: "Networking and Content Delivery",
				weight: 18,
			},
		],
	},
	{
		code: "dea",
		examCode: "DEA-C01",
		fullName: "AWS Certified Data Engineer - Associate (DEA-C01)",
		shortName: "Data Engineer",
		level: "Associate",
		examGuideUrl:
			"https://docs.aws.amazon.com/aws-certification/latest/data-engineer-associate-01/data-engineer-associate-01.html",
		examGuideFetchedAt: "2026-08-08",
		domains: [
			{
				value: "d1",
				label: "データの取り込みと変換",
				labelEn: "Data Ingestion and Transformation",
				weight: 34,
			},
			{
				value: "d2",
				label: "データストアの管理",
				labelEn: "Data Store Management",
				weight: 26,
			},
			{
				value: "d3",
				label: "データ運用とサポート",
				labelEn: "Data Operations and Support",
				weight: 22,
			},
			{
				value: "d4",
				label: "データのセキュリティとガバナンス",
				labelEn: "Data Security and Governance",
				weight: 18,
			},
		],
	},
	{
		code: "mla",
		examCode: "MLA-C01",
		fullName: "AWS Certified Machine Learning Engineer - Associate (MLA-C01)",
		shortName: "Machine Learning Engineer",
		level: "Associate",
		examGuideUrl:
			"https://docs.aws.amazon.com/aws-certification/latest/machine-learning-engineer-associate-01/machine-learning-engineer-associate-01.html",
		examGuideFetchedAt: "2026-08-08",
		domains: [
			{
				value: "d1",
				label: "機械学習のためのデータ準備",
				labelEn: "Data Preparation for Machine Learning (ML)",
				weight: 28,
			},
			{
				value: "d2",
				label: "MLモデルの開発",
				labelEn: "ML Model Development",
				weight: 26,
			},
			{
				value: "d3",
				label: "MLワークフローのデプロイとオーケストレーション",
				labelEn: "Deployment and Orchestration of ML Workflows",
				weight: 22,
			},
			{
				value: "d4",
				label: "MLソリューションのモニタリング・保守・セキュリティ",
				labelEn: "ML Solution Monitoring, Maintenance, and Security",
				weight: 24,
			},
		],
	},
	{
		code: "sap",
		examCode: "SAP-C02",
		fullName: "AWS Certified Solutions Architect - Professional (SAP-C02)",
		shortName: "Solutions Architect",
		level: "Professional",
		examGuideUrl:
			"https://docs.aws.amazon.com/aws-certification/latest/solutions-architect-professional-02/solutions-architect-professional-02.html",
		examGuideFetchedAt: "2026-08-08",
		domains: [
			{
				value: "d1",
				label: "組織の複雑さに対応するソリューション設計",
				labelEn: "Design Solutions for Organizational Complexity",
				weight: 26,
			},
			{
				value: "d2",
				label: "新しいソリューションの設計",
				labelEn: "Design for New Solutions",
				weight: 29,
			},
			{
				value: "d3",
				label: "既存ソリューションの継続的改善",
				labelEn: "Continuous Improvement for Existing Solutions",
				weight: 25,
			},
			{
				value: "d4",
				label: "ワークロードの移行とモダナイゼーションの加速",
				labelEn: "Accelerate Workload Migration and Modernization",
				weight: 20,
			},
		],
	},
	{
		code: "dop",
		examCode: "DOP-C02",
		fullName: "AWS Certified DevOps Engineer - Professional (DOP-C02)",
		shortName: "DevOps Engineer",
		level: "Professional",
		examGuideUrl:
			"https://docs.aws.amazon.com/aws-certification/latest/devops-engineer-professional-02/devops-engineer-professional-02.html",
		examGuideFetchedAt: "2026-08-08",
		domains: [
			{
				value: "d1",
				label: "SDLCの自動化",
				labelEn: "SDLC Automation",
				weight: 22,
			},
			{
				value: "d2",
				label: "構成管理とIaC",
				labelEn: "Configuration Management and IaC",
				weight: 17,
			},
			{
				value: "d3",
				label: "弾力性のあるクラウドソリューション",
				labelEn: "Resilient Cloud Solutions",
				weight: 15,
			},
			{
				value: "d4",
				label: "モニタリングとログ",
				labelEn: "Monitoring and Logging",
				weight: 15,
			},
			{
				value: "d5",
				label: "インシデントとイベントへの対応",
				labelEn: "Incident and Event Response",
				weight: 14,
			},
			{
				value: "d6",
				label: "セキュリティとコンプライアンス",
				labelEn: "Security and Compliance",
				weight: 17,
			},
		],
	},
	{
		code: "aip",
		examCode: "AIP-C01",
		fullName: "AWS Certified Generative AI Developer - Professional (AIP-C01)",
		shortName: "Generative AI Developer",
		level: "Professional",
		examGuideUrl:
			"https://docs.aws.amazon.com/aws-certification/latest/ai-professional-01/ai-professional-01.html",
		examGuideFetchedAt: "2026-08-08",
		domains: [
			{
				value: "d1",
				label: "基盤モデル統合・データ管理・コンプライアンス",
				labelEn:
					"Foundation Model Integration, Data Management, and Compliance",
				weight: 31,
			},
			{
				value: "d2",
				label: "実装と統合",
				labelEn: "Implementation and Integration",
				weight: 26,
			},
			{
				value: "d3",
				label: "AIの安全性・セキュリティ・ガバナンス",
				labelEn: "AI Safety, Security, and Governance",
				weight: 20,
			},
			{
				value: "d4",
				label: "運用効率と最適化",
				labelEn:
					"Operational Efficiency and Optimization for GenAI Applications",
				weight: 12,
			},
			{
				value: "d5",
				label: "テスト・検証・トラブルシューティング",
				labelEn: "Testing, Validation, and Troubleshooting",
				weight: 11,
			},
		],
	},
	{
		code: "ans",
		examCode: "ANS-C01",
		fullName: "AWS Certified Advanced Networking - Specialty (ANS-C01)",
		shortName: "Advanced Networking",
		level: "Specialty",
		examGuideUrl:
			"https://docs.aws.amazon.com/aws-certification/latest/advanced-networking-specialty-01/advanced-networking-specialty-01.html",
		examGuideFetchedAt: "2026-08-08",
		domains: [
			{
				value: "d1",
				label: "ネットワーク設計",
				labelEn: "Network Design",
				weight: 30,
			},
			{
				value: "d2",
				label: "ネットワークの実装",
				labelEn: "Network Implementation",
				weight: 26,
			},
			{
				value: "d3",
				label: "ネットワークの管理と運用",
				labelEn: "Network Management and Operation",
				weight: 20,
			},
			{
				value: "d4",
				label: "ネットワークのセキュリティ・コンプライアンス・ガバナンス",
				labelEn: "Network Security, Compliance, and Governance",
				weight: 24,
			},
		],
	},
	{
		code: "scs",
		examCode: "SCS-C03",
		fullName: "AWS Certified Security - Specialty (SCS-C03)",
		shortName: "Security",
		level: "Specialty",
		// SCS-C02 は 2025-12-01 で提供終了。C02 単体のHTMLガイドは404で消滅している。
		examGuideUrl:
			"https://docs.aws.amazon.com/aws-certification/latest/security-specialty-03/security-specialty-03.html",
		examGuideFetchedAt: "2026-08-08",
		domains: [
			{ value: "d1", label: "検出", labelEn: "Detection", weight: 16 },
			{
				value: "d2",
				label: "インシデント対応",
				labelEn: "Incident Response",
				weight: 14,
			},
			{
				value: "d3",
				label: "インフラストラクチャセキュリティ",
				labelEn: "Infrastructure Security",
				weight: 18,
			},
			{
				value: "d4",
				label: "IDとアクセス管理",
				labelEn: "Identity and Access Management",
				weight: 20,
			},
			{
				value: "d5",
				label: "データ保護",
				labelEn: "Data Protection",
				weight: 18,
			},
			{
				value: "d6",
				label: "セキュリティの基礎とガバナンス",
				labelEn: "Security Foundations and Governance",
				weight: 14,
			},
		],
	},
];

const certsByCode = new Map(certDefinitions.map((cert) => [cert.code, cert]));

export function findCert(code: string): CertDefinition | undefined {
	return certsByCode.get(code);
}

export function certCodes(): string[] {
	return certDefinitions.map((cert) => cert.code);
}

export function certDomains(code: string): ExamDomain[] {
	return findCert(code)?.domains ?? [];
}

export function findDomain(
	code: string,
	value: string,
): ExamDomain | undefined {
	return certDomains(code).find((domain) => domain.value === value);
}

/**
 * 試験ガイドの重みに比例してドメインを1つ引く。
 *
 * rng はテストから差し替えるために引数にしている（[0, 1) を返すこと）。
 * 未知の資格コードでは undefined を返す。
 */
export function pickWeightedDomain(
	code: string,
	rng: () => number = Math.random,
): ExamDomain | undefined {
	const domains = certDomains(code);
	if (domains.length === 0) return undefined;

	const total = domains.reduce((sum, domain) => sum + domain.weight, 0);
	let remaining = rng() * total;
	for (const domain of domains) {
		remaining -= domain.weight;
		if (remaining < 0) return domain;
	}
	// rng が 1 を返した場合など、丸めの端で落ちてきたときの保険。
	return domains[domains.length - 1];
}

/**
 * バンク検索のフォールバック順。先頭は抽選で当たったドメイン、
 * 残りは重みの大きい順（同点は定義順）に並べる。
 */
export function domainFallbackOrder(
	code: string,
	firstDomain: string,
): string[] {
	const domains = certDomains(code);
	if (domains.length === 0) return [firstDomain];

	const rest = domains
		.filter((domain) => domain.value !== firstDomain)
		.sort((a, b) => b.weight - a.weight)
		.map((domain) => domain.value);
	return [firstDomain, ...rest];
}
