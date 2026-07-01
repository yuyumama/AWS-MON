output "table_names" {
  value = module.dynamodb.table_names
}

output "gsi_names" {
  value = module.dynamodb.gsi_names
}
