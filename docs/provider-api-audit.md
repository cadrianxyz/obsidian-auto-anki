# Provider SDK and API audit

Verified on 2026-10-29 against the working tree, current official documentation,
`openai@6.39.1`, and `@anthropic-ai/sdk@1.3.0`.

This audit covers OpenAI and Claude. Future-provider recommendations are design
constraints, not claims that those providers have been implemented.

## Complete request inventory

SDK calls are still API requests. The distinction below is who owns the HTTP
transport, authentication, pagination, and API versioning.

| Operation | Before this refactor | Current implementation | Decision |
|---|---|---|---|
| OpenAI generation | `client.responses.create()` | Same, using a shared OpenAI client factory | Keep SDK |
| Claude generation | `client.messages.create()` | Same, using a shared Anthropic client factory | Keep SDK |
| OpenAI model list | `requestUrl`, manually built `/v1/models` request | `client.models.list()` | Move to SDK |
| Claude model list | `requestUrl`, manually built `/v1/models` request and pagination | `client.models.list()` and SDK `getNextPage()` | Move to SDK; retain defensive pagination guards |
| Public model catalog | `requestUrl` to `https://models.dev/api.json` | Unchanged | Keep separate HTTP integration |
| AnkiConnect | `requestUrl` POST to configured Anki address | Unchanged | Keep separate HTTP integration |

There are no separate capability-probe generations, remote image downloads,
provider file uploads, token-counting requests, streaming generations, response
retrieval/deletion calls, or SDK model-retrieval calls. Diagram attachments are
read locally and embedded in the generation request.

### OpenAI generation

Location: `src/ai/openai/request.ts`.

- Endpoint: `POST https://api.openai.com/v1/responses`.
- Independent nonstreaming calls; `store: false`; no previous-response history.
- Writing instructions use `instructions`; source text and diagrams use `input`.
- Images are base64 data URLs with text labels and `detail: auto`.
- Maximum output uses the typed `max_output_tokens` field.
- Explicit reasoning uses `reasoning.effort`; Model default omits it.
- Schema mode uses `text.format` with `json_schema` and `strict: true`.
- Tool mode defines and selects `submit_notes`; no local function is executed.
- JSON mode uses `text.format.type: json_object`.
- SDK error classes support provider-specific error messages and conservative
  detection of unsupported output formats.
- Response parsing remains application-owned: reject incomplete/refused/malformed
  output and return only final text or the expected function arguments.

### Claude generation

Location: `src/ai/anthropic/request.ts`.

- Endpoint: `POST https://api.anthropic.com/v1/messages`.
- Independent nonstreaming calls with a top-level system prompt.
- Source text and labeled base64 image blocks use the user message.
- Maximum output uses the typed `max_tokens` field.
- Explicit reasoning effort uses `output_config.effort`; Model default omits it.
- Schema mode uses `output_config.format`.
- Tool mode defines and forces the `submit_notes` tool; it is a response envelope,
  not an instruction to execute a tool locally.
- Plain JSON mode relies on fixed response-format instructions; its reader accepts
  one complete JSON object, including one surrounded by fences or prose.
- SDK error classes support provider-specific interpretation.
- Response parsing rejects refusal, token exhaustion, unfinished output, and
  unexpected block/tool shapes. Thinking blocks never become generated notes.

### Shared generation policy and SDK configuration

`src/ai/generation.ts` owns the common request/reply contract and bounded
format fallback. An explicit output choice never falls back. Auto advances only
on an explicit unsupported-format error, not on connection failures, malformed
schemas, refusals, or incomplete responses. Cancellation is checked before sending,
after a failed send, and after a successful send before parsing a late reply.

`src/ai/openai/client.ts` and `src/ai/anthropic/client.ts` each own their provider's
SDK construction for both generation and discovery:

- Explicit first-party endpoint and settings-supplied API key.
- SDK retries disabled to avoid silently repeating paid generations.
- Explicit timeout: ten minutes for generation, ten seconds for model discovery.
- SDK logging disabled; Anthropic telemetry disabled.
- OpenAI organization/project/admin-key and Anthropic alternate-token environment
  defaults explicitly disabled.
- Browser use explicitly enabled for Obsidian's bring-your-own-key runtime.
- Optional fetch injection for tests; request signals are forwarded to the SDK.

Both installed SDKs also consume provider-specific custom-header environment
variables. Those headers can override authentication despite an explicit key.
The factories therefore reject nonempty `OPENAI_CUSTOM_HEADERS` or
`ANTHROPIC_CUSTOM_HEADERS` with an actionable error, without exposing values or
mutating the process environment.

SDK timeout behavior does not establish that a provider stops billing after a
client abort, nor does it guarantee a deadline covering every body-processing step.
Do not describe client cancellation as server-side cancellation.

## Provider-first source layout

```text
src/ai/
  providers.ts       # IDs, display names, and stable Keychain names
  registry.ts        # Provider generation and model-list operations
  generation.ts      # Shared generation contract, output modes, and fallback
  sdk.ts             # SDK environment safety and trusted local errors
  openai/
    client.ts
    request.ts
    models.ts
  anthropic/
    client.ts
    request.ts
    models.ts
  models/
    metadata.ts
    discovery.ts
    selection.ts
    catalog.ts
    catalog-cache.ts
```

Each provider's client configuration, generation protocol, and model listing live
together. Shared workflows depend on the registry, not provider-specific branches.
Provider model readers are private; they are tested through model-list operations.

`models/metadata.ts` defines and validates the plugin's normalized model vocabulary.
`models/catalog.ts` translates one external source, models.dev, into that vocabulary
and validates saved catalogue snapshots. It is not the authoritative account list.

The shared generation policy accepts an explicit supported fallback order for a
provider with different capabilities. OpenAI and Claude retain the existing
schema → tool → JSON order; saved output-mode values are unchanged. Local SDK setup
and model-list validation errors are identified by types, not English-message
matching, while remote errors remain sanitized.

## Model discovery

`src/ai/models/discovery.ts` coordinates refreshes, stale-result protection, cached
catalog metadata, and merging with saved/manual IDs. It does not construct provider
URLs or authentication headers.

`src/ai/openai/models.ts` and `src/ai/anthropic/models.ts` each handle SDK listing
and metadata translation. `src/ai/registry.ts` selects the provider implementation:

- OpenAI's SDK model list is a single page in the installed version. It reports
  IDs, not the capabilities needed to select image/reasoning/output options.
  Supplementary models.dev data remains useful; do not infer abilities from names.
- Claude's SDK exposes cursor pages and model metadata. The plugin retains a page
  limit, repeated/missing-cursor checks, ID deduplication, and validation before
  publishing a complete list. Valid empty lists are allowed; malformed responses
  cannot erase the last good list.
- Claude-reported image input, structured outputs, reasoning efforts, and maximum
  output tokens remain normalized into the plugin's smaller model representation.
- A single aborting deadline covers the complete refresh, including pagination and
  response bodies. Changing credentials or clearing a provider aborts old work.
- Errors retain useful HTTP status information without echoing arbitrary remote
  error text that could expose credentials or request details.

The public catalog remains unauthenticated HTTP: it receives neither provider keys
nor note content, and downloaded metadata cannot change authenticated endpoints.
Its cache remains separate from user settings and account-specific model lists.

## Authentication: Bearer versus x-api-key

**OpenAI uses `Authorization: Bearer <key>`.** Neither the old connector nor the
current official API uses `x-api-key` for this first-party integration.

**Current Claude documentation also specifies Bearer authentication.** It lists
`x-api-key` as a supported legacy fallback. The previous code deliberately removed
the SDK's Bearer header and forced that legacy header; that override was supported,
but unnecessary. Generation and discovery now both use native SDK Bearer auth.
The Anthropic SDK also owns `anthropic-version` and content-type headers.

This is specific to the first-party APIs and installed SDK versions, not a promise
about Azure, Bedrock, Vertex, or compatibility servers. Claude keys not scoped to a
workspace may additionally require `anthropic-workspace-id`; this plugin does not
currently offer workspace selection.

## Removing presets

The old `ProviderPreset` object mixed identity, transport settings, protocol
selection, and documentation. It has been removed rather than replaced with a
larger universal configuration object.

| Former field | Replacement |
|---|---|
| `id` | Record keys and `ProviderId`; duplicated field was unused |
| `name` | Lightweight `PROVIDER_NAMES` identity map |
| `protocol` | Direct `ProviderId` to generation-connector mapping |
| `baseUrl` | Explicit endpoint in each SDK client factory |
| `modelsPath` | SDK model-list implementation |
| `apiKeyHeader`, `apiKeyPrefix` | SDK authentication |
| `headers` | SDK version/header management |
| `outputTokenParameter` | Removed; unused, and typed request bodies already own the fields |
| `docs` | Removed; never read, rendered, fetched, or sent to a model |

The old docs links were developer references only. Relevant authoritative links
are retained below rather than shipped as unused runtime metadata. Provider IDs,
display defaults, Keychain secret names, and the saved settings format are unchanged.

## Future-provider boundaries

- xAI can reuse the OpenAI SDK where Responses compatibility is verified, without
  sharing all provider capabilities, error interpretation, or image constraints.
  Its richer model-list endpoint may warrant a provider-specific discovery method.
- Local Ollama needs keyless connection handling, a configurable host, native
  capability translation, and appropriate output/thinking controls. It must not be
  forced into an API-key preset or the same fallback sequence.
- Gemini should own its native request/response and model-list translation.
- Keep shared generation and discovery contracts small. Use SDKs where suitable,
  but do not require every future provider's discovery to use the same SDK method,
  envelope, pagination scheme, authentication, or output modes.
- models.dev and AnkiConnect do not belong in provider SDK abstractions.

## Official references

- [OpenAI authentication](https://platform.openai.com/docs/api-reference/authentication)
- [OpenAI Responses](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [OpenAI model listing](https://developers.openai.com/api/reference/resources/models/methods/list)
- [OpenAI SDK source and request controls](https://github.com/openai/openai-node/tree/v6.39.1)
- [Claude API overview and authentication](https://platform.claude.com/docs/en/api/overview)
- [Claude Messages](https://platform.claude.com/docs/en/api/messages)
- [Claude model listing](https://platform.claude.com/docs/en/api/models/list)
- [Claude TypeScript SDK](https://platform.claude.com/docs/en/api/sdks/typescript)

## Validation boundary

Official docs, installed source, mocked SDK transport, and automated project tests
were used. No real keys, paid generation calls, or authenticated Obsidian requests
were used for this audit. Actual renderer CORS behavior, live model responses, and
provider-side cancellation/billing remain manual acceptance checks. SDK-backed
model discovery now uses browser fetch rather than Obsidian's CORS-bypassing
`requestUrl`, so those live transport checks matter even though generation already
used SDK fetch. A failed discovery still preserves saved/manual model choices.
