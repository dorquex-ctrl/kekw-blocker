# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in KEKW Blocker, please report it privately. **Do not open a public issue.**

Email: **dorquex@proton.me**

Include:
- Description of the vulnerability
- Steps to reproduce
- Affected files/lines if known

I'll acknowledge receipt within 48 hours and aim to patch confirmed vulnerabilities within 7 days.

## Scope

The following are in scope:
- Code injection via Worker blob construction
- Remote config poisoning
- Extension fingerprinting / detection vectors
- Credential leakage (OAuth tokens, client IDs)
- GitHub Actions workflow exploitation

The following are out of scope:
- Twitch's own security issues
- Browser-level extension sandbox escapes
- Denial of service via ad detection (this is expected behavior)
