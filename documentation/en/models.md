# Models and providers

YOLO doesn't ship any model of its own — you have to connect at least one. This page covers how to connect one, how to tune it, and what each of those "default model" slots actually does.

Where to configure: **Settings → YOLO → Models**.

## Providers

A "provider" is where a model comes from — an API service, or an inference server running on your own machine. Click **Add provider** to open the picker, which is split into these categories:

| Category | Includes |
|------|------|
| **International** | OpenAI, Anthropic, Gemini, Mistral, Perplexity, Groq, xAI, Together AI, Cerebras, SambaNova, Morph |
| **China** | DeepSeek, Moonshot, Zhipu, Doubao, SiliconFlow, StepFun, MiniMax, Hunyuan, Xiaomi MiMo |
| **Gateway** | OpenRouter, APIMart, Fluxion AI |
| **Cloud** | Azure OpenAI, Amazon Bedrock |
| **Local** | Ollama, LM Studio |

The picker also has a separate **Custom provider** card, for any OpenAI-compatible endpoint.

### Custom provider

Reverse proxies, self-hosted gateways, and anything that isn't built in all go through here. You need to fill in:

- **ID** — only used to tell entries apart in your own list, so call it whatever you like
- **API key** — leave it empty if the endpoint doesn't need one
- **Base URL** — for example `https://api.example.com/v1`. The form has a **Preview:** line showing the full address it will actually call, which is very useful when you've got it wrong

There's also a set of advanced options. You won't touch them most of the time, but when something breaks they're the cure:

| Option | When you need it |
|------|-------------|
| **No stainless headers** | Turn it on when headers like `x-stainless-os` are causing CORS errors |
| **Use Obsidian requestUrl** | Works around CORS restrictions. **The cost is that a streamed response gets buffered and handed back in one go** — you lose the typewriter effect |
| **Network request method** | Auto (recommended) / Browser request / Obsidian built-in request / Desktop direct connection (recommended). On desktop, go with Desktop direct connection; on mobile, switch to Obsidian built-in request if the browser request misbehaves |
| **Response streaming mode** | Auto (default) / Streaming / Non-streaming. Switch to Non-streaming by hand when the upstream doesn't support streaming |
| **Prompt caching** | Anthropic-family only, on by default. See the note below |
| **Custom headers** | For extra auth or routing headers |

> **About prompt caching**: Anthropic charges roughly a 25% premium to write to the cache, but a cache hit reads back at about 10% of the normal price. The longer the conversation and the more the prefix repeats, the better the deal — so it's on by default. Turn it off only when the upstream doesn't support `cache_control` or handles it incorrectly.

### Sign in with a subscription account (OAuth)

If you already pay for ChatGPT Plus / Pro or Claude, you can spend that subscription quota directly instead of buying API credit on the side. Look for the entries with an **OAuth** badge in the provider picker:

**ChatGPT OAuth** — two ways to sign in:
- **Browser login**: opens your system browser to authorize (**desktop only**)
- **Device code login**: shows a device code; enter it on the authorization page within 15 minutes. It doesn't occupy a local port, so use this one when you have a port conflict

**Gemini OAuth** — click **Connect** and authorize in the browser, **desktop only**. Once connected it shows the account email and the project ID.

**Claude OAuth** — run ordinary chats on your Claude subscription quota. Two ways to get a token:
- **Auto login** (desktop only): one click and YOLO runs `claude setup-token` for you and fills the result back in
- **Manual**: run `claude setup-token` in your own terminal and paste the token into the box. On Windows, Auto login also just opens a terminal window so you can run it there and paste the result back

Once you're signed in, add chat models to it as usual and pick them in chat — no different from any other provider.

> There is one difference under the hood: requests are carried by the **Claude Agent SDK** rather than an HTTP endpoint. That's why it has no Network request method or Response streaming mode — those transport-layer switches don't apply to it.

After a successful connection the panel shows the connection status and the token expiry, and you can disconnect at any time. When a token expires, sign in again or paste a new one.

## Adding models

Once a provider is set up, expand its card and click **Add chat model**.

- **Single**: search the automatically fetched list of available models, or type in the **Model ID** and **Display name** yourself
- **Batch**: tick several at once and add them all with default parameters, then fine-tune them one by one afterwards

The table header also has a **Connectivity Test**, which fires a test request at one model or at all of them and reports `OK` / `Failed` / `Timeout`, plus the `First token` latency. Run it right after you finish configuring something, or whenever you suspect a model is down.

> A model currently assigned as the **Default chat model** or the **Conversation title model** **can't be deleted, and its enable toggle can't be turned off**. The UI doesn't grey the buttons out in advance — you only get the message after you click. Point the default at something else first, then come back and delete.

### Model parameters

Each model can be configured on its own:

**Model type (the reasoning tier)** — get this one wrong and thinking models behave strangely:

| Type | Extra parameters |
|------|---------|
| Non-reasoning model / default | none |
| OpenAI reasoning_effort style | Reasoning effort: minimal (GPT-5 only) / low / medium / high |
| Gemini thinking_budget style | Thinking budget, in tokens. `0` turns thinking off, `-1` allocates dynamically |
| Anthropic extended thinking (adaptive + effort) | an adaptive toggle plus an effort level |
| Generic reasoning model | none |

**Input modality** — Text, Vision, PDF (native). **This is a declaration, not a switch**: tick a modality the model doesn't actually support and calls fail outright; leave one unticked and you can't upload images in chat even if the model would accept them.

**Built-in provider tools** — the server-side capabilities of Gemini, OpenAI, OpenRouter, Grok and DeepSeek (their own web search, for instance). These are a completely separate thing from YOLO's own web search. Note: **turning on DeepSeek's official web search automatically disables YOLO's own web search tool**, so the two don't fight each other.

**Context window tokens** — filled in automatically for common models. This value isn't decoration: the context usage percentage in [Chat](./chat.md#see-how-much-context-is-used) can only be computed from it.

**Max output tokens**, the **Request parameters** panel (per-field switches — leave one off and the provider's own default applies), and **Custom parameters** (attach any extra field, as text / number / boolean / JSON).

Embedding models have one extra field, **Dimension**, usually auto-detected but editable by hand.

## What each default model slot is for

YOLO has more than one default model; they're several independent slots. Knowing which is which saves real money — handing conversation titles to a cheap small model, for example.

| Slot | Where to set it | What uses it |
|------|--------|--------|
| **Default chat model** | Models → Default model policies & prompts | The model every chat surface starts with |
| **Conversation title model** | Same place | Generates a chat title from the first message. **A cheap small model is the right call here** |
| **Embedding model** | Knowledge tab | Shared by every knowledge base. Changing it invalidates every index |
| **Continuation model** | Sparkle settings | Used by Quick Ask's continuation tab and by selection rewrites. **Also the fallback for tab completion** |
| **Completion model** | Sparkle settings | Tab completion prefers this one; **leave it empty and it falls back to the continuation model** |

## Global system prompt

In the **Default model policies & prompts** block there's a **Global system prompt** box, and whatever you put there is prepended to every conversation.

There's an easy-to-miss but very useful trick here: **you can embed the full text of a note with `![[note name]]`**. So you can write your writing preferences, your glossary, and your project background as a note and reference it from the system prompt — from then on, editing the note is editing the prompt, with no trip back to the settings page.

The same syntax works inside each Agent's system prompt; see [Agent](./assistants.md).

## What to do when requests fail

Two more settings in the same block deal with stability:

- **Enable automatic recovery** (on by default) — when a streaming request times out or fails, retry it once without streaming
- **Primary request timeout (seconds)** (60 by default) — reasoning models think for a long time and hit this limit easily. If you use heavy thinking models and time out often, raise it

For more troubleshooting, see the [FAQ](./faq.md).

---

## Related

- Setting up for the first time: [Getting started](./getting-started.md)
- Embedding models and local inference: [Knowledge base and retrieval](./knowledge-base.md)
- Using a CLI tool you're already signed into instead of an API: [CLI Agent](./cli-agent.md)
