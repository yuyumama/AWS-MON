import { certLevel } from "../lib/certs";

type Props = {
	cert: string;
};

export function CertLevelBadge({ cert }: Props) {
	const level = certLevel(cert);
	if (!level) return null;

	return (
		<span className="tag cert-level-badge" data-level={level}>
			{level}
		</span>
	);
}
