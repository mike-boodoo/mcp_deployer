# Security notes

- Never place `MCP_REGISTRY_TOKEN` in browser JavaScript.
- Treat Registry discovery metadata as untrusted input.
- Do not assume another deployer in the same search space is trusted merely because the entry is discoverable.
- The sample redaction patterns are demonstrations, not a complete secret-scanning solution.
- Add authentication and authorization to `/api/deploy`, `/api/orchestrate`, and `/api/hostResponse` before exposing the local server to a network.
- A published remote MCP server should use HTTPS and enforce its own caller authorization.
