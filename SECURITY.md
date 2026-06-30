# Security Policy

Orbix is self-hosted software intended for trusted LAN deployments. It is not designed to be exposed directly to the public internet without additional hardening such as TLS, a reverse proxy, access controls, and active operational monitoring.

## Supported Versions

Orbix is pre-1.0. Security fixes are handled on the default development branch until the project starts publishing versioned releases.

| Version | Supported |
| --- | --- |
| Default development branch | Yes |
| Older commits and forks | No |

## Reporting a Vulnerability

Do not open a public issue for vulnerabilities.

Use GitHub private vulnerability reporting:

https://github.com/n3r/orbix/security/advisories/new

If that link is unavailable, open a public issue that only asks maintainers to enable a private security contact. Do not include exploit details, secrets, logs, or private deployment information in that public issue.

## What to Include

Please include:

- Affected commit, tag, or deployment method.
- A short description of the vulnerability and impact.
- Reproduction steps or a proof of concept if safe to share privately.
- Relevant logs with secrets removed.
- Whether the issue is already known publicly.

Security-sensitive areas include:

- Authentication, session cookies, profile switching, and setup flows.
- Kids-profile bypasses or missing server-side catalog/playback enforcement.
- Path traversal in images, subtitles, HLS segments, or direct streams.
- ffmpeg/ffprobe process invocation and command argument handling.
- Secret disclosure from settings, logs, build output, or API responses.
- Behavior that writes to or mutates user media files.

## Disclosure

Maintainers will acknowledge valid reports as soon as practical, investigate privately, and coordinate a fix before public disclosure. There is no paid bug bounty program.
