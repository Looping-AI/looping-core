# looping-core

Shared, mandatory foundation for Looping agents on Cloudflare Workers: zero-trust A2A
(signed AgentCard, gateway-JWT verification, no shared secrets), the durable task
lifecycle, the delegation and subagent runtime, and the test harness. Published as
@looping/core with per-area subpath exports. Consumers bring the loop and the prompts;
core brings everything they cannot choose not to have.
