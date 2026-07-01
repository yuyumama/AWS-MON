import React, { useState, useEffect } from 'react';

// 外部CDN依存をなくすためのインラインSVGアイコン（lucide-react不使用）
const Icon = ({ name, size = 18, className = '', spin = false }) => {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className: `${spin ? 'animate-spin ' : ''}${className}`,
  };
  switch (name) {
    case 'chevron-down':
      return (
        <svg {...common}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      );
    case 'book':
      return (
        <svg {...common}>
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </svg>
      );
    case 'check-circle':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" />
          <path d="M8 12l3 3 5-6" />
        </svg>
      );
    case 'x-circle':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" />
          <path d="M15 9l-6 6M9 9l6 6" />
        </svg>
      );
    case 'loader':
      return (
        <svg {...common}>
          <path d="M12 3a9 9 0 1 0 9 9" />
        </svg>
      );
    case 'trophy':
      return (
        <svg {...common}>
          <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
          <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
          <path d="M4 22h16" />
          <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
          <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
          <path d="M18 2H6v7a6 6 0 0 0 12 0V2z" />
        </svg>
      );
    case 'target':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" />
          <circle cx="12" cy="12" r="6" />
          <circle cx="12" cy="12" r="2" />
        </svg>
      );
    case 'layers':
      return (
        <svg {...common}>
          <path d="M12 2l9 5-9 5-9-5 9-5z" />
          <path d="M3 12l9 5 9-5" />
          <path d="M3 17l9 5 9-5" />
        </svg>
      );
    case 'arrow-left':
      return (
        <svg {...common}>
          <path d="M19 12H5" />
          <path d="M12 19l-7-7 7-7" />
        </svg>
      );
    case 'refresh':
      return (
        <svg {...common}>
          <path d="M23 4v6h-6" />
          <path d="M1 20v-6h6" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      );
    default:
      return null;
  }
};

const SESSION_KEY = 'aws_quiz_session_v2';

// アーティファクト用永続ストレージの安全ラッパー（無い環境では無視）
const storageAvailable = typeof window !== 'undefined' && !!(window.storage && window.storage.get && window.storage.set);
const storageGet = async (key) => {
  try {
    if (storageAvailable) return await window.storage.get(key);
  } catch (e) {
    /* noop */
  }
  return null;
};
const storageSet = async (key, value) => {
  try {
    if (storageAvailable) await window.storage.set(key, value);
  } catch (e) {
    /* noop */
  }
};

const AWSCertQuiz = () => {
  const [selectedCert, setSelectedCert] = useState('aip');
  const [selectedDomain, setSelectedDomain] = useState('all');
  const [question, setQuestion] = useState(null);
  const [selectedAnswers, setSelectedAnswers] = useState([]);
  const [showResult, setShowResult] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingExplanation, setIsLoadingExplanation] = useState(false);
  const [explanation, setExplanation] = useState(null);
  const [explanationFailed, setExplanationFailed] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const [nextQuestionData, setNextQuestionData] = useState(null);
  const [isPreloadingNext, setIsPreloadingNext] = useState(false);

  // ロード可視化
  const [elapsed, setElapsed] = useState(0);
  const [genAttempt, setGenAttempt] = useState(0);

  // 復元完了フラグ（復元前に保存して上書きしないため）
  const [restored, setRestored] = useState(false);

  const [stats, setStats] = useState({ totalQuestions: 0, correctAnswers: 0 });

  // 2026年時点で有効な資格のみ（廃止: ML Specialty / DB Specialty / Data Analytics / SAP on AWS / 旧SysOps SOA-C02）
  const certGroups = [
    {
      group: '基礎 (Foundational)',
      items: [
        { value: 'clf', short: 'Cloud Practitioner (CLF-C02)' },
        { value: 'aif', short: 'AI Practitioner (AIF-C01)' },
      ],
    },
    {
      group: 'アソシエイト (Associate)',
      items: [
        { value: 'saa', short: 'Solutions Architect – Associate (SAA-C03)' },
        { value: 'dva', short: 'Developer – Associate (DVA-C02)' },
        { value: 'soa', short: 'CloudOps Engineer – Associate (SOA-C03)' },
        { value: 'dea', short: 'Data Engineer – Associate (DEA-C01)' },
        { value: 'mla', short: 'Machine Learning Engineer – Associate (MLA-C01)' },
      ],
    },
    {
      group: 'プロフェッショナル (Professional)',
      items: [
        { value: 'sap', short: 'Solutions Architect – Professional (SAP-C02)' },
        { value: 'dop', short: 'DevOps Engineer – Professional (DOP-C02)' },
        { value: 'aip', short: '⭐ Generative AI Developer – Professional (AIP-C01)' },
      ],
    },
    {
      group: 'スペシャリティ (Specialty)',
      items: [
        { value: 'ans', short: 'Advanced Networking – Specialty (ANS-C01)' },
        { value: 'scs', short: 'Security – Specialty (SCS-C02)' },
      ],
    },
  ];

  const certFullNames = {
    clf: 'AWS Certified Cloud Practitioner (CLF-C02)',
    aif: 'AWS Certified AI Practitioner (AIF-C01)',
    saa: 'AWS Certified Solutions Architect - Associate (SAA-C03)',
    dva: 'AWS Certified Developer - Associate (DVA-C02)',
    soa: 'AWS Certified CloudOps Engineer - Associate (SOA-C03)',
    dea: 'AWS Certified Data Engineer - Associate (DEA-C01)',
    mla: 'AWS Certified Machine Learning Engineer - Associate (MLA-C01)',
    sap: 'AWS Certified Solutions Architect - Professional (SAP-C02)',
    dop: 'AWS Certified DevOps Engineer - Professional (DOP-C02)',
    aip: 'AWS Certified Generative AI Developer - Professional (AIP-C01)',
    ans: 'AWS Certified Advanced Networking - Specialty (ANS-C01)',
    scs: 'AWS Certified Security - Specialty (SCS-C02)',
  };

  const certDisplayNames = {
    clf: 'Cloud Practitioner (CLF-C02)',
    aif: 'AI Practitioner (AIF-C01)',
    saa: 'Solutions Architect – Associate (SAA-C03)',
    dva: 'Developer – Associate (DVA-C02)',
    soa: 'CloudOps Engineer – Associate (SOA-C03)',
    dea: 'Data Engineer – Associate (DEA-C01)',
    mla: 'Machine Learning Engineer – Associate (MLA-C01)',
    sap: 'Solutions Architect – Professional (SAP-C02)',
    dop: 'DevOps Engineer – Professional (DOP-C02)',
    aip: 'Generative AI Developer – Professional (AIP-C01)',
    ans: 'Advanced Networking – Specialty (ANS-C01)',
    scs: 'Security – Specialty (SCS-C02)',
  };

  // AIP-C01 ドメイン構成（公式試験ガイドの重み）
  const aipDomains = [
    { value: 'all', label: '全ドメイン（重み付けランダム）', en: '', weight: null },
    { value: 'd1', label: '① 基盤モデル統合・データ管理・コンプライアンス', en: 'Foundation Model Integration, Data Management, and Compliance', weight: 31 },
    { value: 'd2', label: '② 実装と統合', en: 'Implementation and Integration', weight: 26 },
    { value: 'd3', label: '③ AIの安全性・セキュリティ・ガバナンス', en: 'AI Safety, Security, and Governance', weight: 20 },
    { value: 'd4', label: '④ 運用効率と最適化', en: 'Operational Efficiency and Optimization for GenAI Applications', weight: 12 },
    { value: 'd5', label: '⑤ テスト・検証・トラブルシューティング', en: 'Testing, Validation, and Troubleshooting', weight: 11 },
  ];

  const isAip = selectedCert === 'aip';

  const getAccuracyRate = () => {
    if (stats.totalQuestions === 0) return 0;
    return Math.round((stats.correctAnswers / stats.totalQuestions) * 100);
  };

  const getAccuracyColor = () => {
    const rate = getAccuracyRate();
    if (rate >= 80) return 'bg-green-500';
    if (rate >= 60) return 'bg-yellow-500';
    return 'bg-red-500';
  };

  const loadingText = () =>
    `問題を生成中... (${elapsed}秒${genAttempt > 1 ? ` ・ 再試行${genAttempt}回目` : ''})`;

  // ---- ユーティリティ ----
  const parseJSON = (text) => {
    let t = (text || '').trim();
    t = t.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const first = t.indexOf('{');
    const last = t.lastIndexOf('}');
    if (first !== -1 && last !== -1) t = t.slice(first, last + 1);
    t = t.replace(/,\s*([}\]])/g, '$1'); // 末尾カンマを除去してパース失敗を減らす
    return JSON.parse(t);
  };

  const normalizeQuestion = (q) => {
    let correct = q.correct;
    if (typeof correct === 'string') correct = [correct];
    if (!Array.isArray(correct)) correct = [];
    const type = q.type === 'multiple' ? 'multiple' : 'single';
    return {
      type,
      question: q.question || '',
      options: q.options || {},
      correct,
      domain: q.domain || '',
    };
  };

  const arraysEqual = (a, b) => {
    if (a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    return sa.every((v, i) => v === sb[i]);
  };

  const pickWeightedDomain = () => {
    const weighted = aipDomains.filter((d) => d.weight);
    const total = weighted.reduce((s, d) => s + d.weight, 0);
    let r = Math.random() * total;
    for (const d of weighted) {
      r -= d.weight;
      if (r <= 0) return d;
    }
    return weighted[0];
  };

  // タイムアウト付きでPromiseを待つ（ハング対策）
  const withTimeout = (promise, ms, label) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label || '応答'}がタイムアウトしました`)), ms)),
    ]);

  // ---- Claude 呼び出し（実績のある内蔵APIを優先 → Messages APIにフォールバック）----
  const TIMEOUT_MS = 30000;

  const callClaude = async (prompt) => {
    // 1) artifact内蔵API（claude.ai のWeb環境で利用可能。元のコードで動作していた経路）
    if (typeof window !== 'undefined' && window.claude && typeof window.claude.complete === 'function') {
      return await withTimeout(Promise.resolve(window.claude.complete(prompt)), TIMEOUT_MS, '生成');
    }
    // 2) 内蔵APIが無い環境（モバイルアプリのサンドボックス等）→ Messages APIにフォールバック
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 2500,
            messages: [{ role: 'user', content: prompt }],
          }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`API ${response.status}`);
        const data = await response.json();
        return data.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      throw new Error(
        `AI生成に接続できませんでした（${e && e.message ? e.message : e}）。この環境ではAI機能が使えない可能性があります。claude.ai をWebブラウザで開いて実行してください。`
      );
    }
  };

  // JSONが取れるまで自動リトライ（ネットワーク失敗・パース失敗・タイムアウトに対応）
  const fetchJSONWithRetry = async (prompt, onAttempt, retries = 2) => {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (onAttempt) onAttempt(attempt + 1);
      try {
        const text = await callClaude(prompt);
        return parseJSON(text);
      } catch (e) {
        lastErr = e;
        console.warn(`生成リトライ ${attempt + 1}/${retries + 1}`, e);
        if (attempt < retries) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    throw lastErr;
  };

  // JSONを壊さないための共通ルール（日本語長文での parse 失敗対策）
  const JSON_RULES = `重要（JSONを壊さないための厳守事項）:
- 出力は純粋なJSONのみ。前置き・後置き・説明文・コードフェンス(\`\`\`)を一切付けない
- JSON文字列の値の中ではダブルクォート(")を使わない。引用が必要なら「」で囲む
- 各値の途中で改行を入れない（1つの値は1行で書く）
- 末尾カンマを付けない`;

  // ---- プロンプト生成 ----
  const buildQuestionPrompt = () => {
    const certName = certFullNames[selectedCert];

    let domainInfo = null;
    if (isAip) {
      domainInfo = selectedDomain === 'all' ? pickWeightedDomain() : aipDomains.find((d) => d.value === selectedDomain);
    }

    const aipContext = isAip
      ? `

【AIP-C01の出題コンテキスト】
この試験はAmazon Bedrockを中心とした本番グレードのGenAI開発を問う。出題時は以下のサービス・概念を適切に織り込むこと：
- Amazon Bedrock（基盤モデル呼び出し、Knowledge Bases、Agents、Guardrails、Prompt Management、Flows、Data Automation、Model Evaluation、Cross-Region Inference、Provisioned Throughput、Prompt Caching）
- ベクトルストア（Amazon S3 Vectors、OpenSearch Serverless、Aurora PostgreSQL pgvector、Amazon Kendra、Neptune Analytics）
- RAG、チャンキング戦略、埋め込み（Titan / Cohere Embeddings）、メタデータフィルタリング
- AgentCore（Runtime / Memory / Gateway / Identity）、Tool Use / Converse APIによる構造化出力
- Step Functions・Lambda・API Gateway によるオーケストレーションと非決定的/決定的処理の使い分け
- ストリーミング応答（streaming API / WebSocket / SSE）、Amazon Cognito 認証
- コスト最適化（モデル選択、バッチ推論、プロンプトキャッシュ）、Responsible AI、IAM / KMS / PrivateLink によるセキュリティ`
      : '';

    const domainClause = domainInfo
      ? `

【今回の出題ドメイン】${domainInfo.label}${domainInfo.en ? `（${domainInfo.en}）` : ''}
このドメインに該当する問題のみを作成すること。`
      : '';

    return `あなたはAWS認定試験の問題作成専門家です。${certName} の試験問題を1問作成してください。${aipContext}${domainClause}

要件:
- 実際の試験と同等の品質・難易度・文量（具体的なシナリオ/ユースケースを含む）
- 選択肢は紛らわしく、注意深く読む必要があるもの
- 問題形式は実試験に合わせて「単一選択」または「複数選択」のいずれかを選ぶ
  - 単一選択: "type":"single", 選択肢A〜D, 正解1つ
  - 複数選択: "type":"multiple", 選択肢A〜E（必要ならF）, 正解2つ以上。設問文に「2つ選択してください」等、必要な正解数を必ず明記
- "correct" は必ず配列で返す（単一選択でも要素1つの配列）

${JSON_RULES}

出力フォーマット（この形のJSONのみ）:
{"type":"single","question":"...","options":{"A":"...","B":"...","C":"...","D":"..."},"correct":["A"]}`;
  };

  const buildExplanationPrompt = (q) => {
    const opts = Object.entries(q.options)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    const reasonsTemplate = Object.keys(q.options)
      .map((k) => `"${k}":"この選択肢の説明（正解なら正しい理由、不正解なら誤りの理由）"`)
      .join(',');

    return `あなたはAWS認定試験の解説作成専門家です。次の問題の解説を作成してください。

問題: ${q.question}
選択肢:
${opts}
正解: ${q.correct.join(', ')}

各説明は簡潔に（1〜2文）。関連するAWSサービス/概念に触れること。

${JSON_RULES}

出力フォーマット（この形のJSONのみ）:
{"overview":"問題の概要と正解の根拠","correct_reason":"正解（${q.correct.join('・')}）が正しい理由","option_reasons":{${reasonsTemplate}},"source":"参考になるAWS公式ドキュメントのURL"}`;
  };

  // ---- 生成処理 ----
  const generateExplanationInBackground = async (q) => {
    setIsLoadingExplanation(true);
    setExplanationFailed(false);
    try {
      const ex = await fetchJSONWithRetry(buildExplanationPrompt(q), null, 3); // 最大4回試行
      setExplanation(ex);
    } catch (e) {
      console.error('Error generating explanation:', e);
      setExplanation(null);
      setExplanationFailed(true);
    } finally {
      setIsLoadingExplanation(false);
    }
  };

  // 次の問題＋解説を先読み（問題が取れた時点で即利用可能にし、解説は後追いで埋める）
  const preloadNextQuestion = async () => {
    if (isPreloadingNext) return;
    setIsPreloadingNext(true);
    try {
      const q = normalizeQuestion(await fetchJSONWithRetry(buildQuestionPrompt(), null));
      setNextQuestionData({ ...q, explanation: null }); // 問題だけ先に準備完了
      try {
        const ex = await fetchJSONWithRetry(buildExplanationPrompt(q), null, 3);
        setNextQuestionData((prev) => (prev ? { ...prev, explanation: ex } : { ...q, explanation: ex }));
      } catch (e) {
        console.warn('解説の先読み失敗（表示時に再生成）', e);
      }
    } catch (e) {
      console.error('Error preloading next question:', e);
      setNextQuestionData(null);
    } finally {
      setIsPreloadingNext(false);
    }
  };

  // 起動時に保存セッションを復元（モバイルのタブ破棄→リロード対策）
  useEffect(() => {
    (async () => {
      try {
        const saved = await storageGet(SESSION_KEY);
        if (saved && saved.value) {
          const s = JSON.parse(saved.value);
          if (s && s.hasStarted && s.question) {
            setSelectedCert(s.selectedCert || 'aip');
            setSelectedDomain(s.selectedDomain || 'all');
            setQuestion(normalizeQuestion(s.question));
            setSelectedAnswers(Array.isArray(s.selectedAnswers) ? s.selectedAnswers : []);
            setShowResult(!!s.showResult);
            setExplanation(s.explanation || null);
            setExplanationFailed(!!s.explanationFailed);
            setStats(s.stats && typeof s.stats.totalQuestions === 'number' ? s.stats : { totalQuestions: 0, correctAnswers: 0 });
            setHasStarted(true);
          }
        }
      } catch (e) {
        /* 保存なし or ストレージ不可。通常起動 */
      } finally {
        setRestored(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 進捗を自動保存（復元完了後のみ。安定した状態だけを保存）
  useEffect(() => {
    if (!restored || !hasStarted) return;
    const snapshot = {
      hasStarted,
      selectedCert,
      selectedDomain,
      question,
      selectedAnswers,
      showResult,
      explanation,
      explanationFailed,
      stats,
    };
    storageSet(SESSION_KEY, JSON.stringify(snapshot));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored, hasStarted, selectedCert, selectedDomain, question, selectedAnswers, showResult, explanation, explanationFailed, stats]);

  // 問題表示後に次の問題を先読み
  useEffect(() => {
    if (question && !showResult && !nextQuestionData && !isPreloadingNext) {
      preloadNextQuestion();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question, showResult]);

  // ロード経過秒のカウント（フリーズしていないことを可視化）
  useEffect(() => {
    if (!isLoading) {
      setElapsed(0);
      return;
    }
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [isLoading]);

  const generateQuestion = async () => {
    setIsLoading(true);
    setGenAttempt(1);
    setQuestion(null);
    setSelectedAnswers([]);
    setShowResult(false);
    setExplanation(null);
    setExplanationFailed(false);
    setErrorMsg('');
    try {
      const q = normalizeQuestion(await fetchJSONWithRetry(buildQuestionPrompt(), setGenAttempt));
      setQuestion(q);
      generateExplanationInBackground(q);
    } catch (e) {
      console.error('Error generating question:', e);
      setErrorMsg(e && e.message ? e.message : '問題の生成に失敗しました。再試行してください。');
    } finally {
      setIsLoading(false);
    }
  };

  const startStudy = () => {
    if (!selectedCert) {
      setErrorMsg('資格を選択してください');
      return;
    }
    setHasStarted(true);
    setStats({ totalQuestions: 0, correctAnswers: 0 });
    setNextQuestionData(null);
    generateQuestion();
  };

  const toggleAnswer = (key) => {
    if (showResult || !question) return;
    if (question.type === 'multiple') {
      setSelectedAnswers((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
    } else {
      setSelectedAnswers([key]);
    }
  };

  const checkAnswer = () => {
    if (selectedAnswers.length === 0) {
      setErrorMsg('回答を選択してください');
      return;
    }
    setErrorMsg('');
    setShowResult(true);
    const isCorrect = arraysEqual(selectedAnswers, question.correct);
    setStats((prev) => ({
      totalQuestions: prev.totalQuestions + 1,
      correctAnswers: prev.correctAnswers + (isCorrect ? 1 : 0),
    }));
  };

  const moveToNextQuestion = () => {
    if (nextQuestionData) {
      const { explanation: preEx, ...q } = nextQuestionData;
      setNextQuestionData(null);
      setQuestion(q);
      setSelectedAnswers([]);
      setShowResult(false);
      setExplanationFailed(false);
      if (preEx) {
        setExplanation(preEx);
        setIsLoadingExplanation(false);
      } else {
        setExplanation(null);
        generateExplanationInBackground(q);
      }
    } else {
      generateQuestion();
    }
  };

  const backToSelection = () => {
    setHasStarted(false);
    setQuestion(null);
    setNextQuestionData(null);
    setSelectedAnswers([]);
    setShowResult(false);
    setExplanation(null);
    setExplanationFailed(false);
    setErrorMsg('');
    setIsLoading(false);
    // 保存セッションをクリア（戻った後にリロードしても復元しないように）
    storageSet(SESSION_KEY, JSON.stringify({ hasStarted: false }));
  };

  const optionStateClass = (key) => {
    const isCorrectOpt = question.correct.includes(key);
    const isSelected = selectedAnswers.includes(key);
    if (!showResult) {
      return isSelected ? 'border-orange-500 bg-orange-50' : 'border-gray-300 hover:border-gray-400';
    }
    if (isCorrectOpt) return 'border-green-500 bg-green-50';
    if (isSelected && !isCorrectOpt) return 'border-red-500 bg-red-50';
    return 'border-gray-200 opacity-70';
  };

  const isCurrentCorrect = question && arraysEqual(selectedAnswers, question.correct);

  return (
    <div className="max-w-4xl mx-auto p-6 bg-gray-50 min-h-screen">
      {/* 正答率バー */}
      {hasStarted && (
        <div className="bg-white rounded-lg shadow-sm p-3 mb-4">
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <div className="flex items-center gap-4">
              <button
                onClick={backToSelection}
                className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 transition-colors"
              >
                <Icon name="arrow-left" size={16} />
                <span>選択へ</span>
              </button>
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <Icon name="target" size={16} />
                <span>問題 {stats.totalQuestions + (question && !showResult ? 1 : 0)}</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <Icon name="trophy" size={16} />
                <span>
                  {stats.correctAnswers}/{stats.totalQuestions} 正解
                </span>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-sm font-medium text-gray-700">正答率: {getAccuracyRate()}%</div>
              {/* 先読み状態の可視化 */}
              {isPreloadingNext ? (
                <div className="flex items-center text-xs text-gray-500">
                  <Icon name="loader" spin size={12} className="mr-1" />
                  <span>次の問題 準備中</span>
                </div>
              ) : nextQuestionData ? (
                <div className="flex items-center text-xs text-green-600 font-medium">
                  <span className="mr-1">✓</span>
                  <span>次の問題 準備完了</span>
                </div>
              ) : null}
            </div>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className={`h-2 rounded-full transition-all duration-500 ${getAccuracyColor()}`}
              style={{ width: `${getAccuracyRate()}%` }}
            />
          </div>
          <div className="mt-2 text-xs text-gray-500 text-center">
            {certDisplayNames[selectedCert]}
            {isAip && selectedDomain !== 'all' && (
              <span> ・ {aipDomains.find((d) => d.value === selectedDomain)?.label}</span>
            )}
          </div>
        </div>
      )}

      {!hasStarted ? (
        <div className="bg-white rounded-lg shadow-lg p-8">
          <h1 className="text-3xl font-bold text-gray-800 mb-2 flex items-center">
            <span className="mr-3 text-orange-500">
              <Icon name="book" size={28} />
            </span>
            AWS資格 模擬問題
          </h1>
          <p className="text-sm text-gray-500 mb-8">AIが実試験レベルの問題を生成します</p>

          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">資格を選択してください</label>
            <div className="relative">
              <select
                value={selectedCert}
                onChange={(e) => {
                  setSelectedCert(e.target.value);
                  setSelectedDomain('all');
                }}
                className="w-full p-3 pr-10 border border-gray-300 rounded-md focus:ring-2 focus:ring-orange-500 focus:border-orange-500 appearance-none bg-white"
              >
                {certGroups.map((g) => (
                  <optgroup key={g.group} label={g.group}>
                    {g.items.map((cert) => (
                      <option key={cert.value} value={cert.value}>
                        {cert.short}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <span className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 pointer-events-none">
                <Icon name="chevron-down" size={20} />
              </span>
            </div>
          </div>

          {/* AIP-C01 ドメイン選択 + 試験情報 */}
          {isAip && (
            <>
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
                  <span className="text-orange-500">
                    <Icon name="layers" size={16} />
                  </span>
                  出題ドメイン
                </label>
                <div className="relative">
                  <select
                    value={selectedDomain}
                    onChange={(e) => setSelectedDomain(e.target.value)}
                    className="w-full p-3 pr-10 border border-gray-300 rounded-md focus:ring-2 focus:ring-orange-500 focus:border-orange-500 appearance-none bg-white"
                  >
                    {aipDomains.map((d) => (
                      <option key={d.value} value={d.value}>
                        {d.label}
                        {d.weight ? `（${d.weight}%）` : ''}
                      </option>
                    ))}
                  </select>
                  <span className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 pointer-events-none">
                    <Icon name="chevron-down" size={20} />
                  </span>
                </div>
              </div>

              <div className="mb-6 p-4 bg-orange-50 border border-orange-100 rounded-lg text-sm text-gray-600">
                <p className="font-medium text-gray-700 mb-1">本試験の概要</p>
                <p>65問（採点対象）+ 10問（採点対象外） / 130分 / スケールスコア 100–1000・合格 750</p>
                <p className="mt-1">出題形式: 単一選択（4択・正解1つ）＋ 複数選択（5択以上・正解2つ以上）</p>
              </div>
            </>
          )}

          {errorMsg && <p className="text-sm text-red-600 mb-4">{errorMsg}</p>}

          <button
            onClick={startStudy}
            disabled={isLoading || !selectedCert}
            className="w-full py-3 px-4 bg-orange-500 text-white font-semibold rounded-md hover:bg-orange-600 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors duration-200 flex items-center justify-center"
          >
            {isLoading ? (
              <>
                <Icon name="loader" spin size={20} className="mr-2" />
                {loadingText()}
              </>
            ) : (
              '学習を開始'
            )}
          </button>

          {storageAvailable && (
            <p className="text-xs text-gray-400 mt-3 text-center">
              進捗は自動保存され、ページを再読み込みしても途中から復元されます。
            </p>
          )}
        </div>
      ) : (
        <>
          {question && (
            <div className="bg-white rounded-lg shadow-lg p-8">
              <div className="mb-8">
                <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                  <div className="flex items-center gap-3">
                    <h2 className="text-xl font-semibold text-gray-800">問題</h2>
                    <span
                      className={`text-xs px-2 py-1 rounded-full font-medium ${
                        question.type === 'multiple' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
                      }`}
                    >
                      {question.type === 'multiple' ? `複数選択（${question.correct.length}つ選択）` : '単一選択'}
                    </span>
                  </div>
                  {isLoadingExplanation && !showResult && (
                    <div className="flex items-center text-xs text-gray-500">
                      <Icon name="loader" spin size={12} className="mr-1" />
                      <span>解説準備中...</span>
                    </div>
                  )}
                </div>
                <p className="text-gray-700 leading-relaxed whitespace-pre-wrap">{question.question}</p>
              </div>

              <div className="mb-8">
                <div className="space-y-3">
                  {Object.entries(question.options).map(([key, value]) => (
                    <label
                      key={key}
                      className={`block p-4 border rounded-lg cursor-pointer transition-all duration-200 ${optionStateClass(
                        key
                      )}`}
                    >
                      <input
                        type={question.type === 'multiple' ? 'checkbox' : 'radio'}
                        name="answer"
                        value={key}
                        checked={selectedAnswers.includes(key)}
                        onChange={() => toggleAnswer(key)}
                        disabled={showResult}
                        className="mr-3"
                      />
                      <span className="text-gray-700">
                        <strong>{key}.</strong> {value}
                      </span>
                      {showResult && question.correct.includes(key) && (
                        <span className="inline-block ml-2 align-middle text-green-600">
                          <Icon name="check-circle" size={20} />
                        </span>
                      )}
                      {showResult && selectedAnswers.includes(key) && !question.correct.includes(key) && (
                        <span className="inline-block ml-2 align-middle text-red-600">
                          <Icon name="x-circle" size={20} />
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              </div>

              {errorMsg && <p className="text-sm text-red-600 mb-4">{errorMsg}</p>}

              {!showResult ? (
                <button
                  onClick={checkAnswer}
                  disabled={selectedAnswers.length === 0}
                  className="w-full py-3 px-4 bg-blue-500 text-white font-semibold rounded-md hover:bg-blue-600 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors duration-200"
                >
                  回答を確認
                </button>
              ) : (
                <div className="space-y-6">
                  <div className={`p-4 rounded-lg ${isCurrentCorrect ? 'bg-green-100' : 'bg-red-100'}`}>
                    <p className="text-lg font-semibold mb-2">
                      {isCurrentCorrect ? (
                        <span className="text-green-800">✓ 正解です！</span>
                      ) : (
                        <span className="text-red-800">✗ 不正解です</span>
                      )}
                    </p>
                    <p className="text-gray-700">
                      正解: <strong>{question.correct.join('、 ')}</strong>
                    </p>
                  </div>

                  {isLoadingExplanation ? (
                    <div className="bg-gray-50 p-6 rounded-lg">
                      <div className="flex items-center justify-center">
                        <Icon name="loader" spin size={20} className="mr-2" />
                        <span className="text-gray-600">解説を生成中...</span>
                      </div>
                    </div>
                  ) : explanationFailed ? (
                    <div className="bg-red-50 border border-red-100 p-6 rounded-lg text-center">
                      <p className="text-red-700 mb-3">解説の生成に失敗しました。</p>
                      <button
                        onClick={() => generateExplanationInBackground(question)}
                        className="inline-flex items-center gap-2 py-2 px-4 bg-orange-500 text-white font-semibold rounded-md hover:bg-orange-600 transition-colors duration-200"
                      >
                        <Icon name="refresh" size={16} />
                        解説を再生成
                      </button>
                    </div>
                  ) : explanation ? (
                    <div className="bg-gray-50 p-6 rounded-lg">
                      <h3 className="text-lg font-semibold text-gray-800 mb-4">解説</h3>

                      <div className="space-y-4">
                        {explanation.overview && (
                          <div>
                            <h4 className="font-medium text-gray-700 mb-2">概要</h4>
                            <p className="text-gray-600 leading-relaxed">{explanation.overview}</p>
                          </div>
                        )}

                        {explanation.correct_reason && (
                          <div>
                            <h4 className="font-medium text-gray-700 mb-2">正解の理由</h4>
                            <p className="text-gray-600 leading-relaxed">{explanation.correct_reason}</p>
                          </div>
                        )}

                        {explanation.option_reasons && Object.keys(explanation.option_reasons).length > 0 && (
                          <div>
                            <h4 className="font-medium text-gray-700 mb-2">各選択肢について</h4>
                            <div className="space-y-2">
                              {Object.entries(explanation.option_reasons).map(([key, reason]) => {
                                const correct = question.correct.includes(key);
                                return (
                                  <div key={key} className="pl-1">
                                    <p className={`text-gray-600 ${correct ? 'font-medium' : ''}`}>
                                      <span className={correct ? 'text-green-700' : 'text-gray-500'}>
                                        {correct ? '◯' : '✕'} <strong>{key}.</strong>
                                      </span>{' '}
                                      {reason}
                                    </p>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {explanation.source && (
                          <div>
                            <h4 className="font-medium text-gray-700 mb-2">参考資料</h4>
                            <p className="text-blue-600 break-all">{explanation.source}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : null}

                  <button
                    onClick={moveToNextQuestion}
                    className="w-full py-3 px-4 bg-orange-500 text-white font-semibold rounded-md hover:bg-orange-600 transition-colors duration-200 flex items-center justify-center gap-2"
                  >
                    次の問題へ
                    {nextQuestionData && <span className="text-xs bg-orange-400 px-2 py-0.5 rounded-full">準備済</span>}
                  </button>
                </div>
              )}

              <p className="mt-6 text-xs text-gray-400 text-center">
                ※ 問題・解説はAIによる生成です。AWS公式の試験問題ではありません。
              </p>
            </div>
          )}

          {isLoading && (
            <div className="bg-white rounded-lg shadow-lg p-8 flex flex-col items-center justify-center">
              <div className="flex items-center">
                <span className="text-orange-500 mr-2">
                  <Icon name="loader" spin size={22} />
                </span>
                <span className="text-gray-600">{loadingText()}</span>
              </div>
              {elapsed >= 20 && (
                <p className="text-xs text-gray-400 mt-3 text-center">
                  時間がかかっています。生成が混み合っている可能性があります。
                  <br />
                  さらに待っても変わらなければ「選択へ」で戻って再開できます。
                </p>
              )}
            </div>
          )}

          {errorMsg && !question && !isLoading && (
            <div className="bg-white rounded-lg shadow-lg p-8 text-center">
              <p className="text-red-600 mb-4">{errorMsg}</p>
              <button
                onClick={generateQuestion}
                className="py-2 px-4 bg-orange-500 text-white font-semibold rounded-md hover:bg-orange-600 transition-colors duration-200"
              >
                再試行
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default AWSCertQuiz;