data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

data "aws_region" "current" {}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

# CognitoとGuardrailはアカウント固有値のため、オーナーが作成したSSMから読む。
data "aws_ssm_parameter" "cognito_user_pool_id" {
  name = "/app/aws-mon/prod/cognito-user-pool-id"
}

data "aws_ssm_parameter" "cognito_client_id" {
  name = "/app/aws-mon/prod/cognito-client-id"
}

data "aws_ssm_parameter" "agent_guardrail_id" {
  name = "/app/aws-mon/prod/agent-guardrail-id"
}

locals {
  name_prefix = "aws-mon-prod"

  table_names = {
    questions       = "${local.name_prefix}-questions"
    sessions        = "${local.name_prefix}-sessions"
    user_activity   = "${local.name_prefix}-user-activity"
    generation_jobs = "${local.name_prefix}-generation-jobs"
  }

  api_image_ready   = var.api_image_tag != ""
  agent_image_ready = var.agent_image_tag != ""
  runtime_enabled   = local.agent_image_ready
  app_enabled       = local.api_image_ready && local.runtime_enabled

  api_repository_url   = aws_ecr_repository.api.repository_url
  agent_repository_url = aws_ecr_repository.agent.repository_url

  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = data.aws_region.current.region

  web_bucket_name = "${local.name_prefix}-web-${local.account_id}"

  table_arns = [
    for name in values(local.table_names) :
    "arn:${local.partition}:dynamodb:${local.region}:${local.account_id}:table/${name}"
  ]

  table_index_arns = [
    for name in values(local.table_names) :
    "arn:${local.partition}:dynamodb:${local.region}:${local.account_id}:table/${name}/index/*"
  ]

  lambda_environment = {
    AUTH_MODE             = "cognito"
    COGNITO_USER_POOL_ID  = data.aws_ssm_parameter.cognito_user_pool_id.value
    COGNITO_CLIENT_ID     = data.aws_ssm_parameter.cognito_client_id.value
    QUESTIONS_TABLE       = local.table_names.questions
    SESSIONS_TABLE        = local.table_names.sessions
    USER_ACTIVITY_TABLE   = local.table_names.user_activity
    GENERATION_JOBS_TABLE = local.table_names.generation_jobs
    AGENT_MODE            = "agentcore"
    AGENT_RUNTIME_ARN     = local.runtime_enabled ? aws_bedrockagentcore_agent_runtime.agent[0].agent_runtime_arn : ""
    # 既定値(APIロール)。ADR 0013 で初回生成・先読みとも非同期job化したため、API Lambda から
    # AgentCore を同期呼び出しする経路は残っていない。将来そういう経路を足しても
    # API Lambda の timeout=300 を超えないよう、保険として短めに固定する。
    # 実際に生成を待つのは worker で、下の aws_lambda_function.worker が上書きする。
    AGENT_REQUEST_TIMEOUT_MS = "120000"
  }

  agent_environment = {
    OPENROUTER_API_KEY_PARAM        = "/app/aws-mon/prod/openrouter-api-key"
    AGENT_MODEL_ID                  = var.agent_model_id
    AGENT_GUARDRAIL_ID              = data.aws_ssm_parameter.agent_guardrail_id.value
    AGENT_GUARDRAIL_VERSION         = var.agent_guardrail_version
    AGENT_OBSERVABILITY_ENABLED     = "true"
    OTEL_PYTHON_DISTRO              = "aws_distro"
    OTEL_PYTHON_CONFIGURATOR        = "aws_configurator"
    OTEL_EXPORTER_OTLP_PROTOCOL     = "http/protobuf"
    OTEL_TRACES_EXPORTER            = "otlp"
    OTEL_RESOURCE_ATTRIBUTES        = "service.name=aws-mon-quiz-agent,aws.log.group.names=/aws/aws-mon/quiz-agent"
    OTEL_EXPORTER_OTLP_LOGS_HEADERS = "x-aws-log-group=/aws/aws-mon/quiz-agent,x-aws-log-stream=runtime-logs,x-aws-metric-namespace=aws-mon-agent"
  }
}

# アプリが共有する4つのDynamoDBテーブルを既存モジュールで作る。
module "dynamodb" {
  source = "../../modules/dynamodb"

  table_names = local.table_names
}

# APIとworkerは同一ECRリポジトリでタグを分ける。
resource "aws_ecr_repository" "api" {
  name                 = "${local.name_prefix}-api"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

# AgentCore Runtime用のarm64コンテナを格納する。
resource "aws_ecr_repository" "agent" {
  name                 = "${local.name_prefix}-agent"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

# webビルド成果物の配信元。公開はCloudFront OACのみに絞る。
resource "aws_s3_bucket" "web" {
  bucket = local.web_bucket_name
}

resource "aws_s3_bucket_server_side_encryption_configuration" "web" {
  bucket = aws_s3_bucket.web.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket = aws_s3_bucket.web.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${local.name_prefix}-web-oac"
  description                       = "OAC for aws-mon prod web bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "web" {
  enabled             = true
  comment             = "aws-mon prod web"
  default_root_object = "index.html"
  price_class         = "PriceClass_200"

  origin {
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_id                = "s3-${aws_s3_bucket.web.id}"
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-${aws_s3_bucket.web.id}"
    viewer_protocol_policy = "redirect-to-https"
    cache_policy_id        = data.aws_cloudfront_cache_policy.caching_optimized.id
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
  }

  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }

  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

data "aws_iam_policy_document" "web_bucket" {
  statement {
    sid     = "AllowCloudFrontRead"
    effect  = "Allow"
    actions = ["s3:GetObject"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    resources = ["${aws_s3_bucket.web.arn}/*"]

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.web.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = data.aws_iam_policy_document.web_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.web]
}

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api" {
  name               = "${local.name_prefix}-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role" "worker" {
  name               = "${local.name_prefix}-worker"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

data "aws_iam_policy_document" "lambda_app" {
  count = local.app_enabled ? 1 : 0

  statement {
    sid = "WriteLogs"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/${local.name_prefix}-*:*"]
  }

  statement {
    sid = "UseApplicationTables"
    actions = [
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:ConditionCheckItem",
      "dynamodb:DeleteItem",
      "dynamodb:DescribeTable",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:UpdateItem",
    ]
    resources = concat(local.table_arns, local.table_index_arns)
  }

  statement {
    sid     = "InvokeAgentRuntime"
    actions = ["bedrock-agentcore:InvokeAgentRuntime"]
    # 実際の呼び出し先はエンドポイントのサブリソース(.../runtime-endpoint/DEFAULT)のため、
    # Runtime本体だけでなくエンドポイントARNも許可する必要がある(ライブで実測)
    resources = [
      aws_bedrockagentcore_agent_runtime.agent[0].agent_runtime_arn,
      "${aws_bedrockagentcore_agent_runtime.agent[0].agent_runtime_arn}/runtime-endpoint/*",
    ]
  }
}

resource "aws_iam_role_policy" "api_app" {
  count = local.app_enabled ? 1 : 0

  name   = "${local.name_prefix}-api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.lambda_app[0].json
}

resource "aws_iam_role_policy" "worker_app" {
  count = local.app_enabled ? 1 : 0

  name   = "${local.name_prefix}-worker"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.lambda_app[0].json
}

resource "aws_lambda_function" "api" {
  count = local.app_enabled ? 1 : 0

  function_name = "${local.name_prefix}-api"
  role          = aws_iam_role.api.arn
  package_type  = "Image"
  image_uri     = "${local.api_repository_url}:${var.api_image_tag}"
  timeout       = 300
  memory_size   = 512
  # reserved_concurrent_executions は設定しない: このアカウントのLambda同時実行
  # クォータが小さく、予約すると未予約分の最低値10を割ってapplyが失敗する。
  # アカウント全体の上限自体が暴走時のコストキャップとして機能する。

  environment {
    variables = local.lambda_environment
  }

  lifecycle {
    ignore_changes = [image_uri]
  }

  depends_on = [aws_iam_role_policy.api_app]
}

resource "aws_lambda_function_url" "api" {
  count = local.app_enabled ? 1 : 0

  function_name      = aws_lambda_function.api[0].function_name
  authorization_type = "NONE"

  cors {
    allow_origins = ["https://${aws_cloudfront_distribution.web.domain_name}"]
    allow_headers = ["authorization", "content-type"]
    # OPTIONSは指定不可(各要素6文字以下の制約)。プリフライトはFunction URLが自動応答する
    allow_methods = ["GET", "POST", "PUT", "PATCH", "DELETE"]
    max_age       = 86400
  }
}

resource "aws_lambda_function" "worker" {
  count = local.app_enabled ? 1 : 0

  function_name = "${local.name_prefix}-worker"
  role          = aws_iam_role.worker.arn
  package_type  = "Image"
  image_uri     = "${local.api_repository_url}:worker-latest"
  timeout       = 900
  memory_size   = 512
  # reserved_concurrent_executions は設定しない(apiと同じクォータ理由)。
  # worker重複起動はjobのclaim(state条件付きUpdate + lockedBy)で排他される。
  # lockedUntil は「落ちたworkerが掴んだままのRUNNING jobを回収する期限」であって、
  # 排他そのものではない(ADR 0013 決定6)。

  environment {
    variables = merge(local.lambda_environment, {
      WORKER_JOBS_LIMIT = "5"
      # 生成の実測は中央値190秒 / p90 284秒 / 最大429秒(ADR 0013)。最大値に十分な
      # マージンを取って600秒にする。jobのロック期限とworkerの時間予算はこの値から
      # 算出される(jobExecutionBudgetMs = 本値 + 30秒)ため、worker Lambda の
      # timeout=900 との関係は「1呼び出しで概ね2件処理して打ち切り」になる。
      AGENT_REQUEST_TIMEOUT_MS = "600000"
    })
  }

  lifecycle {
    ignore_changes = [image_uri]
  }

  depends_on = [aws_iam_role_policy.worker_app]
}

data "aws_iam_policy_document" "scheduler_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${local.name_prefix}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume_role.json
}

data "aws_iam_policy_document" "scheduler" {
  count = local.app_enabled ? 1 : 0

  statement {
    sid       = "InvokeWorker"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.worker[0].arn]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  count = local.app_enabled ? 1 : 0

  name   = "${local.name_prefix}-scheduler"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler[0].json
}

resource "aws_scheduler_schedule" "worker" {
  count = local.app_enabled ? 1 : 0

  name                = "${local.name_prefix}-worker-schedule"
  schedule_expression = "rate(1 minute)"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.worker[0].arn
    role_arn = aws_iam_role.scheduler.arn
  }

  depends_on = [aws_iam_role_policy.scheduler]
}

resource "aws_scheduler_schedule" "stale_worker" {
  count = local.app_enabled ? 1 : 0

  name                = "${local.name_prefix}-stale-worker-schedule"
  schedule_expression = "rate(1 day)"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.worker[0].arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ task = "stale" })
  }

  depends_on = [aws_iam_role_policy.scheduler]
}

data "aws_iam_policy_document" "agent_runtime_assume_role" {
  statement {
    sid     = "AssumeRolePolicy"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["bedrock-agentcore.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:bedrock-agentcore:${local.region}:${local.account_id}:*"]
    }
  }
}

resource "aws_iam_role" "agent_runtime" {
  name               = "${local.name_prefix}-agent-runtime"
  assume_role_policy = data.aws_iam_policy_document.agent_runtime_assume_role.json
}

data "aws_iam_policy_document" "agent_runtime" {
  statement {
    sid = "ECRImageAccess"
    actions = [
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.agent.arn]
  }

  statement {
    sid       = "ECRTokenAccess"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  # DescribeLogGroupsだけはログループ名で絞れない(list系)ため対象を分ける。
  statement {
    sid       = "DescribeLogGroups"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:*"]
  }

  statement {
    sid = "RuntimeLogs"
    actions = [
      "logs:CreateLogGroup",
      "logs:DescribeLogStreams",
    ]
    resources = [
      "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/aws/bedrock-agentcore/runtimes/*",
      "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/aws/aws-mon/quiz-agent",
    ]
  }

  statement {
    sid = "RuntimeLogStreams"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*",
      "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/aws/aws-mon/quiz-agent:log-stream:*",
    ]
  }

  statement {
    sid = "XRay"
    actions = [
      "xray:GetSamplingRules",
      "xray:GetSamplingTargets",
      "xray:PutTelemetryRecords",
      "xray:PutTraceSegments",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "PutMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["bedrock-agentcore", "aws-mon-agent"]
    }
  }

  statement {
    sid = "GetAgentAccessToken"
    actions = [
      "bedrock-agentcore:GetWorkloadAccessToken",
      "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
      "bedrock-agentcore:GetWorkloadAccessTokenForUserId",
    ]
    resources = [
      "arn:${local.partition}:bedrock-agentcore:${local.region}:${local.account_id}:workload-identity-directory/default",
      "arn:${local.partition}:bedrock-agentcore:${local.region}:${local.account_id}:workload-identity-directory/default/workload-identity/aws_mon_prod_agent-*",
    ]
  }

  statement {
    sid       = "OpenRouterApiKeyParameter"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:${local.partition}:ssm:${local.region}:${local.account_id}:parameter/app/aws-mon/prod/openrouter-api-key"]
  }

  statement {
    sid       = "ApplyGuardrail"
    actions   = ["bedrock:ApplyGuardrail"]
    resources = ["arn:${local.partition}:bedrock:${local.region}:${local.account_id}:guardrail/${data.aws_ssm_parameter.agent_guardrail_id.value}"]
  }
}

resource "aws_iam_role_policy" "agent_runtime" {
  name   = "${local.name_prefix}-agent-runtime"
  role   = aws_iam_role.agent_runtime.id
  policy = data.aws_iam_policy_document.agent_runtime.json
}

# フェーズ3のローカル検証(setup_observability.sh)で作成済みのロググループを
# Terraform管理へ取り込む。初回apply成功後、このimportブロックは削除してよい。
import {
  to = aws_cloudwatch_log_group.agent_observability
  id = "/aws/aws-mon/quiz-agent"
}

resource "aws_cloudwatch_log_group" "agent_observability" {
  name              = "/aws/aws-mon/quiz-agent"
  retention_in_days = 30
}

resource "aws_bedrockagentcore_agent_runtime" "agent" {
  count = local.runtime_enabled ? 1 : 0

  agent_runtime_name    = "aws_mon_prod_agent"
  description           = "aws-mon prod quiz generation agent"
  role_arn              = aws_iam_role.agent_runtime.arn
  environment_variables = local.agent_environment

  agent_runtime_artifact {
    container_configuration {
      container_uri = "${local.agent_repository_url}:${var.agent_image_tag}"
    }
  }

  network_configuration {
    network_mode = "PUBLIC"
  }

  protocol_configuration {
    server_protocol = "HTTP"
  }

  lifecycle {
    ignore_changes = [
      agent_runtime_artifact[0].container_configuration[0].container_uri,
    ]
  }

  depends_on = [
    aws_cloudwatch_log_group.agent_observability,
    aws_iam_role_policy.agent_runtime,
  ]
}

# deploy-webが参照する静的配信先を書き出す。
resource "aws_ssm_parameter" "web_bucket" {
  name  = "/app/aws-mon/prod/web-bucket"
  type  = "String"
  value = aws_s3_bucket.web.bucket
}

resource "aws_ssm_parameter" "cloudfront_distribution_id" {
  name  = "/app/aws-mon/prod/cloudfront-distribution-id"
  type  = "String"
  value = aws_cloudfront_distribution.web.id
}

# Function URL作成後だけwebビルド用API URLを書き出す。
# function_urlは末尾スラッシュ付きのため、パス連結で"//"にならないよう除去して格納する。
resource "aws_ssm_parameter" "api_base_url" {
  count = local.app_enabled ? 1 : 0

  name  = "/app/aws-mon/prod/api-base-url"
  type  = "String"
  value = trimsuffix(aws_lambda_function_url.api[0].function_url, "/")
}

# deploy-agentがRuntime更新可否を判定するためのID。
resource "aws_ssm_parameter" "agent_runtime_id" {
  count = local.runtime_enabled ? 1 : 0

  name  = "/app/aws-mon/prod/agent-runtime-id"
  type  = "String"
  value = aws_bedrockagentcore_agent_runtime.agent[0].agent_runtime_id
}
