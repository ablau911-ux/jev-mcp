# Security

## Threat model

jev-mcp sends code and text to TypeSafe. The secret guard protects against **accidental
leaks**: an agent or a user pastes a log, a config file, a diff or an error message that
happens to hold a credential, and that credential must not leave the machine or land on disk.

The agent using jev-mcp is assumed to be cooperative. A party that **deliberately obfuscates**
a secret to get it past the guard is **out of scope**.

## Covered

- **Known secret shapes**: PEM private keys, AWS keys, GitHub, Gitea and Slack tokens, JWTs,
  Bearer tokens, `secret=...` / `password=...` style assignments, connection strings.
- **Live secrets read at runtime**: the TypeSafe key and the tea CLI token(s). They are masked
  wherever they appear, including when they are split across fields (fragments of 8 or more
  characters, or a quarter of the secret when it is longer). Their hex, base64 (every byte
  alignment, standard and URL-safe) and percent-encoded forms are registered as plain
  substrings too, so an encoded live secret is refused whatever the decode budget.
- **Every value next to a secret-like key** (`password`, `secret`, `token`, `api_key`, ...),
  in every format: code, `.env`, YAML (block scalars masked whole), Dockerfile `ENV`, JSON,
  logs (only the secret field). Exempt: an empty value, a placeholder (`changeme`,
  `<YOUR_TOKEN>`) and a well-formed variable expansion (`$X`, `${X}`, `${{ ... }}`, `$(...)`,
  `%X%`).
- **Common encodings, plus one nested level**: base64 (standard and URL-safe), hex, percent
  encoding and `\u` / `\x` escapes, and one of these inside another (base64 of percent,
  percent of percent, hex of base64). Decoding has a fixed budget (4x the input); an encoded
  run that needs more is not decoded (it is still scanned as plain text, live secrets
  included), never refused.
- **Every sink**: the wire payload, MCP results and errors, logs, the decision log, the usage
  ledger, the response cache and `output_path` files (file names included).
- **Images**: PNG text chunks and EXIF, JPEG COM and APPn segments are stripped.
- **Structural controls**: files are read only inside the allowed roots (symlinks resolved;
  `$diff` hunks for paths outside are refused); credential files (`.env`, `.ssh/`, key files,
  the tea config, ...) are never read; credentials are never accepted as tool arguments.

## Modes

`mode: refuse` refuses on any detection; the default is redact. In redact mode a detected
secret is masked as `[REDACTED:<kind>]` and the request is still sent; only a registered live
secret (the TypeSafe key, a tea token) that cannot be masked, e.g. split across fields or
encoded, refuses the request.

## Known limits (out of scope: contrived constructs)

The guard targets realistic accidental leaks. Constructs that an honest agent or user would
not produce, and that only serve to get a value past the guard, are known limits:

- deliberately unbalanced or nested shell constructs (`$(a $(b) c`, `${{ ${{ x }} }}`) and
  other expansion look-alikes built around a literal secret;
- values crafted to evade the value boundary (a secret glued after whitespace, a quote or a
  comment marker on purpose, or spread over keys and fields in an unnatural order);
- base32, ROT13, reversed strings or any custom encoding, and more than one nested level of
  the supported encodings;
- homoglyphs (look-alike Unicode characters) and zero-width characters inside a secret or a
  key name;
- a secret cut into fragments shorter than 8 characters;
- a secret under a key name that does not look secret-like (`x = hunter2`).

Secrets that only the user knows (not a known shape, not registered, not next to a
secret-like key) can not be recognised either. Do not paste them.

### Hardening is closed (2026-10-22, round 45)

Pattern hardening is closed after round 45. Every review round found a narrower evasion shape,
so more rounds would not converge. The primary controls are the credential-file denylist and
exact masking of registered live secrets; the pattern guard is a second layer. New shapes are
residual risk, reported as issues and fixed only when a realistic accidental leak needs it.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **private vulnerability reporting**:
open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a
public issue for a security problem. Describe the input shape that leaks and the sink it
reaches. Use synthetic secrets only; never include a real credential in a report.
