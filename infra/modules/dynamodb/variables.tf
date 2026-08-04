variable "table_names" {
  description = "DynamoDB table names."
  type = object({
    questions       = string
    sessions        = string
    user_activity   = string
    generation_jobs = string
  })
}

variable "gsi_names" {
  description = "DynamoDB GSI names. Keep these in sync with packages/shared."
  type = object({
    questions = object({
      bank_random   = string
      stale_due     = string
      content_hash  = string
      question_list = string
    })
    sessions = object({
      user_status = string
      abandon_due = string
    })
    user_activity = object({
      review_list = string
      due_list    = string
    })
    generation_jobs = object({
      runnable = string
    })
  })
  default = {
    questions = {
      bank_random   = "GSI1_BankRandom"
      stale_due     = "GSI2_StaleDue"
      content_hash  = "GSI3_ContentHash"
      question_list = "GSI4_QuestionList"
    }
    sessions = {
      user_status = "GSI1_UserStatus"
      abandon_due = "GSI2_AbandonDue"
    }
    user_activity = {
      review_list = "GSI1_ReviewList"
      due_list    = "GSI2_DueList"
    }
    generation_jobs = {
      runnable = "GSI1_Runnable"
    }
  }
}
