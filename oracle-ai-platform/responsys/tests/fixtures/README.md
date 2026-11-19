# Test fixtures

Every file here is **synthetic, test-only data**. None of it is customer data, and none of it is
loaded by the application in development, production, or demo startup. Tests upload these files
through the real import API.

- `golden-campaigns.csv` — the blueprint 20.2 golden fixture (TEST-CAMP-A/B) plus TEST-CAMP-C in the
  preceding week so the comparison expectations (+3 pp open rate, −500.00 revenue) can be asserted.
- `legacy-summary.csv` — the legacy account-period export format with nested windows.
