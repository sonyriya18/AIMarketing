export const CONNECT_DOCS = 'https://docs.oracle.com/en/cloud/saas/marketing/responsys-develop/API/REST/AdvancedAPI/';

export interface ConnectAdvice { title: string; steps: string[]; verification: string; reference: string }
/** Suggested investigation steps, never an assertion that a provider failure has been repaired. */
export function connectAdvice(category: string | null, message = ''): ConnectAdvice {
  const ref = CONNECT_DOCS + 'api-v1.3-connectJobs-jobId-logs-get.htm';
  const base = { verification: 'After correcting the configuration in Responsys, check the next run and pull jobs again. Confirm SUCCEEDED and review rejected records.', reference: ref };
  if (/credentials_missing/.test(message)) return { ...base, title: 'Configure the server credentials', steps: ['Store the Responsys API username and password under the connection’s server secret reference.', 'Restart the local server after changing its environment, then test the connection.'] };
  if (/network|timeout|UND_ERR|ENOTFOUND|ECONN|TLS|CERT/.test(message)) return { ...base, title: 'Restore HTTPS access to Responsys', steps: ['Copy the exact WS End Point from Responsys: Account → Global settings → Account configuration. Compare it with this connection’s login URL.', 'Check that the required VPN or corporate proxy is active and that DNS and outbound HTTPS on port 443 can reach this host.', 'For certificate errors, ask IT to configure the approved certificate trust store. Keep TLS certificate validation enabled.'], verification: 'Test the connection again. After authentication succeeds, use Pull jobs from API to populate the charts.' };
  if (/permission|denied|API_DISABLED|CONNECT_DISABLED|\b403\b/.test(message)) return { ...base, title: 'Check API access', steps: ['Ask the Responsys administrator to verify that Connect and Advanced API access are enabled for this API user.', 'Test the connection again after access is updated.'] };
  if (/rate_limited|\b429\b/.test(message)) return { ...base, title: 'Wait for the API limit to reset', steps: ['Respect Retry-After when provided; avoid repeated manual pulls.', 'Reduce polling frequency and retry with exponential backoff.'] };
  if (/not_found|CONNECT_JOB_NOT_FOUND|HTTP 404/.test(message)) return { ...base, title: 'Check the unavailable job history', steps: ['Compare the reported job and run IDs with the job in Responsys Connect.', 'Confirm that run history exists for the selected dates and that the API user can access it. Ask the Responsys administrator to investigate IDs that continue returning 404.'], verification: 'Pull the same date range again after access or provider data is corrected. Review the warning count; a partial pull contains only the history that the API returned.' };
  if (category === 'missing_source_file' || /no files? (?:were |was )?found/i.test(message)) return { ...base, title: 'Check the source file', steps: ['In Responsys Connect, compare the configured folder and filename pattern with the file on the SFTP server.', 'Verify that upload completes before the job’s schedule and that the API job references the correct source.'] };
  if (category === 'schema_mismatch') return { ...base, title: 'Review field mapping', steps: ['Compare the source headers, delimiter, field order and target field types with the Connect mapping.', 'Correct the mapping or source file, then validate a small file before the next run.'] };
  if (category === 'encoding') return { ...base, title: 'Align file encoding', steps: ['Compare the source file encoding with the job’s configured encoding.', 'Re-export the file using the configured encoding and inspect invalid characters.'] };
  if (category === 'data_format') return { ...base, title: 'Validate rejected values', steps: ['Review the error log and rejected records for invalid dates, numbers or required fields.', 'Match the job’s date format, timezone and target field constraints before re-uploading.'] };
  if (category === 'transfer_or_auth' || /auth|network|timeout/.test(message)) return { ...base, title: 'Check authentication and transfer access', steps: ['Verify the API credentials and correct Responsys login pod; for file-transfer errors, check the SFTP host, port, path and credentials.', 'Review connectivity and allowlists. Test again before retrying the run.'] };
  return { ...base, title: 'Investigate the provider log', steps: ['Open the run’s error message and timestamped logs below to identify the failed operation.', 'Check the job configuration in Responsys Connect. If the cause remains unclear, provide the job ID, run ID and redacted error to Oracle support.'] };
}

export interface ConnectRun {
  id: string; jobId: string; jobName: string; externalJobId: string; externalRunId: string;
  status: string; startedAt: string | null; endedAt: string | null;
  recordsProcessed: string | null; recordsRejected: string | null;
  errorCategory: string | null; errorMessage: string | null;
  logs: { logLevel: string; logMessage: string; logTime: string | number | null }[];
  detailWarning: string | null; advice: ConnectAdvice | null;
}
export interface ConnectDiagnostics {
  from: string; to: string; timezone: string;
  connections: { id: string; name: string; status: string; lastError: string | null; lastSyncAt: string | null; syncStatus: string | null; syncDetail: string | null; advice: ConnectAdvice | null }[];
  jobs: { id: string; name: string; externalJobId: string; jobType: string | null; connectionName: string; lastSyncedAt: string; runs: number; succeeded: number; failed: number; running: number; aborted: number; unknown: number }[];
  trend: { date: string; succeeded: number; failed: number; running: number; aborted: number; unknown: number }[];
  errors: { category: string; count: number }[];
  totals: { jobs: number; runs: number; succeeded: number; failed: number; running: number; aborted: number; unknown: number };
  runs: ConnectRun[]; runLimit: number; truncated: boolean;
}
