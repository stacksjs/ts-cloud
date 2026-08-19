# Security posture center

The security posture center turns individual checks into a persistent, auditable deployment decision. Open `/security` in either the server or serverless dashboard to review current risk, scanner health, policy, waivers, and recent production decisions.

## How a deployment is evaluated

Every check is normalized into a scanner run and zero or more findings. Findings have a stable fingerprint, so repeated scans update the same record. A clean follow-up scan resolves findings that disappeared; if a resolved issue returns, the posture center reopens it and increments its recurrence count.

Before a deployment mutation, ts-cloud evaluates the active environment policy against:

- unresolved findings and their severity;
- scanner-specific and general block, warn, or record rules;
- required scanners and whether their latest result is skipped, unavailable, unsupported, or stale;
- active waivers that apply to the finding and policy.

The decision records the policy ID and version, scanner versions, finding IDs, waiver IDs, outcome, and a plain-language explanation. That snapshot remains useful even after the policy changes.

## Default policies

Production uses a fail-closed baseline. `source-secrets` is required, critical and high findings block, medium findings warn, and lower severities are recorded. Non-production environments fail open by default and warn instead of blocking.

Use the policy editor to change required scanners, scanner failure behavior, or severity rules. Saving policy changes and managing waivers require recent authentication and the appropriate security capability.

Fail closed means a required scanner in `skipped`, `unavailable`, `unsupported`, or `stale` state blocks. Fail open keeps that degraded state visible but permits the operation with a warning. Optional scanners never silently become required.

## Scanner health and local execution

The center currently understands these checks:

| Scanner | Purpose | Behavior when unavailable |
|---|---|---|
| `source-secrets` | Detect credentials and private keys in source/build output | Required by the default policy |
| `trivy-image` | Scan a built container for known vulnerabilities | Visible as unsupported/unavailable unless made required |
| `syft-sbom` | Produce a full CycloneDX image inventory | Falls back to a package-manifest CycloneDX SBOM |
| `host-posture` | Normalize firewall, listener, TLS, and host diagnostic state | Other checks and the posture page remain available |
| `aws-iam-capabilities` | Check the actual caller identity and required deployment actions | Reports unsupported guidance when AWS cannot simulate the active principal |

Trivy and Syft run as bounded local child processes with a minimal environment. Source, image contents, credentials, and reports are not uploaded by ts-cloud. Scanner output and errors are redacted before persistence.

For AWS, configured credentials alone are not treated as proof of access. The capability scanner calls STS for the active identity and IAM policy simulation for the exact requested actions. Assumed-role identities that cannot be safely simulated are reported as unsupported rather than incorrectly marked healthy.

## Container release artifacts

`cloud deploy:container` applies two gates:

1. The build context is checked before the image is built.
2. After the image is pushed, Trivy scans the immutable image and ts-cloud attaches a CycloneDX SBOM, vulnerability summary, and SLSA/in-toto provenance to the content-addressed release. Policy is evaluated again before ECS is updated.

If the second gate blocks, the image remains in ECR for investigation but the running ECS service is not changed. When Syft is unavailable, a package-manifest SBOM is attached when `package.json` exists and scanner health clearly reports the fallback. Release artifact bodies are sensitive by default; ordinary reads expose metadata and digests without returning their content.

## Finding workflow

Use search and the severity, status, and scanner filters to narrow the queue. Each finding shows evidence, remediation, first and last seen time, and recurrence count. Operators with permission can:

- assign or unassign an owner;
- acknowledge an issue without suppressing policy;
- add a note and an HTTPS reference to a ticket or incident;
- create a waiver with a reason, optional policy/reference, and mandatory expiry;
- revoke a waiver or verify that remediation resolved the finding.

A waiver lasts no more than one year and expires automatically. It is not a blanket scanner bypass: it covers one finding, and it can be pinned to one policy. Creation, expiry, and revocation are written to the audit event stream.

## Production change review

The review panel previews the current production decision before an operation. It includes the desired configuration hash, counts of critical/high/waived/assigned findings, blocking IDs, policy version, and scanner versions. Use it immediately before a high-risk change; the actual deployment still evaluates and records its own decision.

## API and export

Dashboard sessions can use these endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/security/posture` | Findings, scan health, policies, waivers, artifacts, and decisions |
| `GET` | `/api/security/export` | Redacted posture export for audit or incident evidence |
| `POST` | `/api/security/scan` | Run available checks |
| `POST` | `/api/security/review` | Preview a production policy decision |
| `POST`, `PATCH` | `/api/security/policies` | Create or version a policy |
| `POST`, `DELETE` | `/api/security/waivers` | Create or revoke a waiver |
| `PATCH` | `/api/security/findings` | Assign or acknowledge a finding |
| `POST` | `/api/security/comments` | Add a finding note/reference |

The dashboard authorizes reads, management, and waivers separately through `security:read`, `security:manage`, and `security:waive`. Exports are redacted and omit sensitive release artifact content.

## Remediation checklist

When a deployment blocks:

1. Open the blocking finding and confirm the scanner, subject, and evidence.
2. Follow its remediation guidance and rotate any exposed credential at the issuer.
3. Rebuild or rerun checks; do not use `--skip-security-scan` as a bypass.
4. Confirm the finding resolves and the review outcome allows the change.
5. If the business must proceed, create the narrowest short-lived waiver with an owner, reason, and ticket link, then remove it as soon as remediation ships.
