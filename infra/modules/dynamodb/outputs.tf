output "table_names" {
  value = {
    questions       = aws_dynamodb_table.questions.name
    sessions        = aws_dynamodb_table.sessions.name
    user_activity   = aws_dynamodb_table.user_activity.name
    generation_jobs = aws_dynamodb_table.generation_jobs.name
  }
}

output "gsi_names" {
  value = var.gsi_names
}
