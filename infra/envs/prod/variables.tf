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

variable "agent_model_id" {
  description = "OpenRouter model id used for question generation (ADR 0016, reverted 2026-08-08 after OpenRouter retired the ling-3.0-flash free tier). Forward path: switch to inclusionai/ling-3.0-flash (paid) once cost is acceptable."
  type        = string
  default     = "nvidia/nemotron-3-ultra-550b-a55b:free"

  validation {
    condition     = length(trimspace(var.agent_model_id)) > 0
    error_message = "agent_model_id must not be empty."
  }
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

