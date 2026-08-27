# Security

Please report security issues privately through GitHub's security advisory interface for this repository. Do not include
credentials, private project manifests, command output, or personal paths in a public issue.

The plugin executes only tasks declared by bounded root or explicitly declared workspace manifests and rediscovered with a
matching SHA-256 digest. Workspace traversal rejects escaping patterns and symlink directories. Background execution and
collection reuse Harness's owner-fenced JobRegistry; Project Ops does not register a second job runtime.

Version-2 receipts and verification-gate results exclude commands, absolute paths, task output, environment values, approval
text, and sandbox policy text. Harness remains responsible for shell-tool visibility, approval, sandboxing, cancellation, and
result retention.
