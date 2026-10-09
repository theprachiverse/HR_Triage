# HR Services and Assignment Groups

The agent maps each HR service to one assignment group. The mapping lives in `SERVICE_GROUP` in `src/HRTriageAgent.js`.

| HR service | Assignment group |
|---|---|
| General Benefits Inquiry | HR Benefits Team |
| Employee Payroll Setup Request | HR Payroll Team |
| Leave of Absence | HR Leave & Verification Team |
| Employment Verification | HR Leave & Verification Team |
| General Inquiry | HR Benefits Team (fallback / triage) |

Notes:
- **Employee Payroll Setup Request** already exists in the HRSD demo data and is used here as the payroll service.
- **Employment Verification** was created for this project.
- **General Inquiry** is the fallback. A case classified as General Inquiry is always escalated.
