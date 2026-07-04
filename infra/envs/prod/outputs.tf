output "web_bucket" {
  value = aws_s3_bucket.web.bucket
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.web.id
}

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.web.domain_name
}

output "api_base_url" {
  value = local.app_enabled ? aws_lambda_function_url.api[0].function_url : null
}

output "agent_runtime_id" {
  value = local.runtime_enabled ? aws_bedrockagentcore_agent_runtime.agent[0].agent_runtime_id : null
}
