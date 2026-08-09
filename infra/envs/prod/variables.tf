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

variable "agent_judge_model_id" {
  description = "OpenRouter model id for the self-consistency judge (ADR 0018). Empty string disables the judge. Must differ from agent_model_id: judging with the generation model is self-critique, which ADR 0007 removed. Selected by calibration on 2026-08-09: the only candidate meeting the bar (8/9 defective detected, 0/3 clean rejected, 0 errors)."
  type        = string
  default     = "nvidia/nemotron-3-super-120b-a12b:free"
}
