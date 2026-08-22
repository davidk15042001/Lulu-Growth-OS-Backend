# DeepSeek API reference notes

Sources reviewed:

- https://api-docs.deepseek.com/
- https://api-docs.deepseek.com/api/create-chat-completion/
- https://api-docs.deepseek.com/quick_start/pricing/
- https://api-docs.deepseek.com/guides/tool_calls/

Relevant facts:

- Direct OpenAI-compatible base URL: `https://api.deepseek.com`.
- Current documented models include `deepseek-v4-pro` and `deepseek-v4-flash`.
- Direct API supports chat completions, Responses API, JSON output, and tool calls.
- DeepSeek reasoning can consume the output limit; structured website JSON requests should explicitly disable thinking when content must be returned in a bounded `max_tokens` response.
- Official pricing is variable by peak/off-peak period and should be verified on the pricing page before customer billing changes.
