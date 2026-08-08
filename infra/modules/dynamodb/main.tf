locals {
  question_bank_projection = [
    "cert",
    "domain",
    "domainSelection",
    "type",
    "question",
    "options",
    "validUntil",
    "status",
  ]

  question_list_projection = [
    "cert",
    "domain",
    "status",
  ]

  session_user_status_projection = [
    "userId",
    "status",
    "cert",
    "domainSelection",
    "mode",
    "current",
    "prefetch",
    "answeredCount",
    "correctCount",
    "startedAt",
    "updatedAt",
    "completedAt",
  ]

  review_list_projection = [
    "questionId",
    "cert",
    "domain",
    "reviewMarked",
    "reviewMarkedAt",
    "answerCount",
    "correctCount",
    "lastCorrect",
    "lastAnsweredAt",
    "weaknessScore",
    "updatedAt",
  ]

  due_list_projection = [
    "questionId",
    "cert",
    "domain",
    "nextReviewAt",
    "answerCount",
    "correctCount",
    "lastCorrect",
    "weaknessScore",
    "updatedAt",
  ]

  runnable_job_projection = [
    "kind",
    "state",
    "sessionId",
    "targetSequence",
    "cert",
    "domainSelection",
    "domain",
    "mode",
    "questionId",
    "sourceQuestionId",
    "attemptCount",
    "maxAttempts",
    "runAfter",
    "lockedUntil",
    "updatedAt",
  ]
}

resource "aws_dynamodb_table" "questions" {
  name         = var.table_names.questions
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "questionId"

  attribute {
    name = "questionId"
    type = "S"
  }

  attribute {
    name = "bankPk"
    type = "S"
  }

  attribute {
    name = "bankSk"
    type = "S"
  }

  attribute {
    name = "stalePk"
    type = "S"
  }

  attribute {
    name = "staleSk"
    type = "S"
  }

  attribute {
    name = "hashPk"
    type = "S"
  }

  attribute {
    name = "hashSk"
    type = "S"
  }

  attribute {
    name = "listPk"
    type = "S"
  }

  attribute {
    name = "listSk"
    type = "S"
  }

  ttl {
    attribute_name = "deleteAt"
    enabled        = true
  }

  global_secondary_index {
    name               = var.gsi_names.questions.bank_random
    hash_key           = "bankPk"
    range_key          = "bankSk"
    projection_type    = "INCLUDE"
    non_key_attributes = local.question_bank_projection
  }

  global_secondary_index {
    name            = var.gsi_names.questions.stale_due
    hash_key        = "stalePk"
    range_key       = "staleSk"
    projection_type = "KEYS_ONLY"
  }

  global_secondary_index {
    name            = var.gsi_names.questions.content_hash
    hash_key        = "hashPk"
    range_key       = "hashSk"
    projection_type = "KEYS_ONLY"
  }

  global_secondary_index {
    name               = var.gsi_names.questions.question_list
    hash_key           = "listPk"
    range_key          = "listSk"
    projection_type    = "INCLUDE"
    non_key_attributes = local.question_list_projection
  }
}

resource "aws_dynamodb_table" "sessions" {
  name         = var.table_names.sessions
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "sessionId"
  range_key    = "itemKey"

  attribute {
    name = "sessionId"
    type = "S"
  }

  attribute {
    name = "itemKey"
    type = "S"
  }

  attribute {
    name = "userStatusPk"
    type = "S"
  }

  attribute {
    name = "userStatusSk"
    type = "S"
  }

  attribute {
    name = "abandonPk"
    type = "S"
  }

  attribute {
    name = "abandonSk"
    type = "S"
  }

  ttl {
    attribute_name = "deleteAt"
    enabled        = true
  }

  global_secondary_index {
    name               = var.gsi_names.sessions.user_status
    hash_key           = "userStatusPk"
    range_key          = "userStatusSk"
    projection_type    = "INCLUDE"
    non_key_attributes = local.session_user_status_projection
  }

  global_secondary_index {
    name            = var.gsi_names.sessions.abandon_due
    hash_key        = "abandonPk"
    range_key       = "abandonSk"
    projection_type = "KEYS_ONLY"
  }
}

resource "aws_dynamodb_table" "user_activity" {
  name         = var.table_names.user_activity
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "itemKey"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "itemKey"
    type = "S"
  }

  attribute {
    name = "reviewPk"
    type = "S"
  }

  attribute {
    name = "reviewSk"
    type = "S"
  }

  attribute {
    name = "duePk"
    type = "S"
  }

  attribute {
    name = "dueSk"
    type = "S"
  }

  ttl {
    attribute_name = "deleteAt"
    enabled        = true
  }

  global_secondary_index {
    name               = var.gsi_names.user_activity.review_list
    hash_key           = "reviewPk"
    range_key          = "reviewSk"
    projection_type    = "INCLUDE"
    non_key_attributes = local.review_list_projection
  }

  global_secondary_index {
    name               = var.gsi_names.user_activity.due_list
    hash_key           = "duePk"
    range_key          = "dueSk"
    projection_type    = "INCLUDE"
    non_key_attributes = local.due_list_projection
  }
}

resource "aws_dynamodb_table" "generation_jobs" {
  name         = var.table_names.generation_jobs
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "jobId"

  attribute {
    name = "jobId"
    type = "S"
  }

  attribute {
    name = "runPk"
    type = "S"
  }

  attribute {
    name = "runSk"
    type = "S"
  }

  ttl {
    attribute_name = "deleteAt"
    enabled        = true
  }

  global_secondary_index {
    name               = var.gsi_names.generation_jobs.runnable
    hash_key           = "runPk"
    range_key          = "runSk"
    projection_type    = "INCLUDE"
    non_key_attributes = local.runnable_job_projection
  }
}
