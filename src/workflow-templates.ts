export const workflowTemplateApplicationIds = {
  finance_payable: "wftp_app_n8q4v2m7x5p1r9t6c3a0b8d2",
  expense_reimbursement: "wftp_app_h3k9s1v6p4x8q2m7c5t0a9r1",
  financial_report_extraction: "wftp_app_y6p2m8q4v1c9t3x7n5r0h2k6"
} as const;

export const workflowTemplateKeys = Object.keys(workflowTemplateApplicationIds);
export const workflowTemplateIds = Object.values(workflowTemplateApplicationIds);
