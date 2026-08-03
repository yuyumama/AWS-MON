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

variable "agent_guardrail_version" {
  description = "Published Bedrock guardrail version used by the grounding gate. Roll back by setting a previous version (1 = grounding 0.7)."
  type        = string
  default     = "2"

  validation {
    condition     = can(regex("^([0-9]+|DRAFT)$", var.agent_guardrail_version))
    error_message = "agent_guardrail_version must be a published version number or DRAFT."
  }
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
