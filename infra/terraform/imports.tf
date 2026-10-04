# Adopt resources that existed before Terraform (FND-03). materia-v2-dev and materia-v2-prod were
# created in the Firebase console and upgraded to Blaze, which also enabled some APIs and created a
# budget. Import blocks (not `terraform import`) because they work with for_each addresses and
# plan like any other change. Once a resource is in state its import block is a no-op, so these
# stay in place; a new environment leaves the adopt_* variables at their defaults.

import {
  for_each = var.adopt_existing_project ? toset([var.project_id]) : toset([])
  to       = module.env.google_project.this
  id       = each.value
}

import {
  for_each = var.adopt_existing_project ? toset([var.project_id]) : toset([])
  to       = module.env.google_firebase_project.this
  id       = "projects/${each.value}"
}

import {
  for_each = toset(var.adopt_enabled_services)
  to       = module.env.google_project_service.this[each.value]
  id       = "${var.project_id}/${each.value}"
}

import {
  for_each = var.adopt_budget_id == null ? toset([]) : toset([var.adopt_budget_id])
  to       = module.env.google_billing_budget.monthly
  id       = "billingAccounts/${var.billing_account}/budgets/${each.value}"
}
