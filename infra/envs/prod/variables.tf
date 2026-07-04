variable "api_image_tag" {
  description = "API Lambda image tag. Empty string skips API, worker, Function URL, Scheduler, and API URL output."
  type        = string
  default     = ""
}

variable "agent_image_tag" {
  description = "AgentCore Runtime image tag. Empty string skips AgentCore Runtime and runtime ID output."
  type        = string
  default     = ""
}

variable "bedrock_model_id" {
  description = "Bedrock model ID used by the AgentCore Runtime."
  type        = string
  default     = "us.anthropic.claude-sonnet-4-20250514-v1:0"
}
