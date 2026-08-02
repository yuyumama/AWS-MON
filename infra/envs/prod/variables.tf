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
  default     = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
}

variable "agent_model_provider" {
  description = "Model provider used by the AgentCore Runtime."
  type        = string
  default     = "openrouter"

  validation {
    condition     = contains(["bedrock", "openrouter"], var.agent_model_provider)
    error_message = "agent_model_provider must be either bedrock or openrouter."
  }
}
