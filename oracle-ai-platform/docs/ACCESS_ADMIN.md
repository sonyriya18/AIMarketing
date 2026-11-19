# Access, subscriptions and approvals

- **Workspace = client company.** Users see only the companies they belong to.
- **Subscriptions are controlled by the platform provider**, not by the company:
  - Provider administrators are the emails in `PLATFORM_ADMIN_EMAILS` and `BOOTSTRAP_EMAIL`. Locally, with neither set, the first person to sign in.
  - In the **Provider console**, the provider can:
    - create companies (name, address, first administrator);
    - tick each company's tools (Responsys, Eloqua, Unity, Infinity) with optional start and end dates (UTC);
    - suspend or reactivate a company;
    - add administrators;
    - set a company-specific Responsys v17 address and check that v17 is running.
  - A company sees only tools that are ticked, inside their dates, while the company is active. This is enforced on the server for every request, background job, AI tool call and the Responsys sign-in (`docs/RESPONSYS_SSO.md`).
  - Company administrators see their subscription in Settings but cannot change it. Every change is written to the company's audit log.
  - This platform does not verify Oracle licences.
- **User application access**: within the subscription, company administrators choose which tools each Analyst or Viewer may use. Administrators see all subscribed tools.
- **Roles.**

  | Role | What they can do |
  |---|---|
  | Administrator | Workspace, members, sources, connections, policies, mappings, deletion |
  | Analyst | Upload, assess, scenarios, actions, drafts, investigations, schedules, feedback; never sees provider secrets |
  | Viewer | Read and export only |

  Analysts can also be granted **Connector administration** (configure, test, sync, cancel jobs) and **Approvals** (approve drafts and playbooks).
- **Separation of duties**: the author of a draft cannot approve it.
- **Source accounts**: each instance or environment (production, test, sandbox) is a separate source. "Restricted" sources are visible only to administrators and named members.
- Every check runs on the server for every request, background job and AI tool call. Removing a tool, suspending a company or removing a member takes effect on the next request. An already-open Responsys v17 session lasts until v17's own session expiry.
- **Production sign-in** is OIDC only (`AUTH_MODE=oidc`, verified email claim, PKCE, state and nonce). The email-only development login is disabled in production, and production refuses to start with `AUTH_MODE=dev`.
