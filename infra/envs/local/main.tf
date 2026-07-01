module "dynamodb" {
  source = "../../modules/dynamodb"

  table_names = var.table_names
}
