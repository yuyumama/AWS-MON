variable "table_names" {
  type = object({
    questions       = string
    sessions        = string
    user_activity   = string
    generation_jobs = string
  })
}
