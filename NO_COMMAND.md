# No-command deployment

The main UI is `index.html`. Open it directly in a browser for editing, local configuration, orchestration, export, and connection diagnostics.

For real authenticated MCP Registry publication, the same UI should be served by the included backend (or an equivalent deployed backend). The page then has explicit `Login to MCP Registry` and `Connect npm` buttons. Clicking Deploy automatically starts the missing login flow instead of stopping at a generic “login required” message.

The Connection debug log shows real upstream HTTP statuses, request IDs, and redacted response bodies; the backend emits corresponding structured logs.
