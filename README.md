# Decision Arcade

A realtime Tetris showcase for **Microsoft-Decision-1**. Node.js owns the game state, `ws` streams it to the browser, and the frontend is plain HTML, CSS, and JavaScript. No frontend framework or build step.

## Run

Requires **Node.js 22.9+** (Node.js 24 LTS recommended).

```powershell
npm install
npm start
```

Open **http://127.0.0.1:3000**. The app works immediately in **Local demo** mode, which uses a board heuristic and makes no Azure requests.

## Connect Azure Foundry

Create your private `.env` file from the safe template if it does not already exist:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Fill in your `.env`:

```dotenv
AZURE_ENDPOINT=https://YOUR-RESOURCE.services.ai.azure.com
AZURE_API_KEY=your-api-key
DEPLOYMENT_NAME=microsoft-decision-1
```

1. Deploy Microsoft-Decision-1 in your Azure Foundry resource.
2. Copy the **resource endpoint** and API key from your deployment details. Use the base resource URL, without a project, `/openai`, or `/chat/completions` path. The full `/providers/microsoft/v1/systemone` URL is also accepted.
3. Set `DEPLOYMENT_NAME` to the name **you gave your deployment**; it may differ from the model name.
4. Save `.env`, restart `npm start`, and select **Decision-1**. Live mode is selected by default when credentials are present. Press **Start game** to begin making requests.

The API key stays on the server. `.env` is ignored by Git and is never served over HTTP. `.env.example` is a shareable template. Existing shell environment variables take precedence over values in `.env`.

Integration follows [Microsoft's Foundry Decision API guide](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision): `POST /providers/microsoft/v1/systemone`, the `api-key` header, your deployment name in `model`, and a named `choice` question under `questions`. This is a decision API, not a chat-completions API.

## How the model plays

1. The engine simulates reachable landings and shortlists up to **8** legal placements. A compact request includes the board and next pieces; each candidate's metrics are sent once in its choice description.
2. **Microsoft-Decision-1 chooses a placement**, using `answers.placement.choice`. The engine checks reachability from the piece's current position before applying it.
3. Once a model placement is known, the engine predicts its resulting board and requests the **next piece's** decision while the current piece falls. At spawn, the prepared choice is accepted only if that predicted board matches the actual board. There is still at most one remote request in flight per game.
4. While a response is pending, a local heuristic supplies provisional steering. If the model choice arrives in time, it takes over. If the piece locks first, its decision card is explicitly labeled **Local safety**. Safety moves never count as model responses or populate model latency. This lets 4× gameplay survive network delays without freezing or disguising local play as model output.
5. Pausing, resetting, changing pilots, or disconnecting cancels pending and prepared work. If only one legal placement remains, the engine executes a labeled forced move without an API call.

Gravity and steering run on independent clocks, and the browser animates the active piece with `requestAnimationFrame` between WebSocket updates. Replies that arrive too late are recorded but not applied. The playback speed does not speed up Azure inference. This is a bounded placement-selection demonstration: the local engine supplies simulated metrics, a shortlist, and explicit safety steering.

Shape rotations are cached. Revalidation searches for a reachable path without rescoring every board. P50/P95 are calculated only when a model response arrives. The full JSON response panel is retained; its bodies and decision history are transmitted only when they change, rather than on every frame.

Live telemetry shows measured **server → Foundry → server** latency, P50/P95 over the last 500 successful responses, successful model response counts, actual model placements, and local safety moves. Local computation never populates model latency. Decision cards display simulated board outcomes and API-supplied probabilities. Prepared choices are labeled until their piece spawns.

The **Model responses** panel shows the complete JSON from the last 10 successful model responses, alongside each response's measured request time, returned model, and receipt time. It follows the latest response by default; use the selector to inspect an earlier one. Responses remain available when switching to local or manual play and clear when the game resets. Demo and forced moves do not generate model responses.

API failures pause live play and show a useful error. **Retry decision** makes a new request; there is no automatic retry or silent fallback. For a 429, wait for quota to recover and try a lower speed. Pausing aborts the local request but may not prevent a request already received by Azure from being billed.

## Controls

| Control | Action |
| --- | --- |
| Left / right arrows | Move |
| Up arrow | Rotate clockwise |
| Z | Rotate counterclockwise |
| Down arrow | Soft drop |
| Space | Hard drop |
| P | Pause / resume |

Movement keys and on-screen touch controls work in **Manual** mode. Click the board to give it keyboard focus if another control is focused. Each browser tab has an independent game.

The engine uses a seven-piece bag, a landing ghost, simple horizontal wall kicks, line-clear scoring, and increasing gravity in manual mode. It uses a compact rotation ruleset rather than the full competitive Tetris guideline; there is no hold, T-spin scoring, or lock delay.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AZURE_ENDPOINT` | empty | Azure Foundry resource URL |
| `AZURE_API_KEY` | empty | Resource API key |
| `DEPLOYMENT_NAME` | `microsoft-decision-1` | Actual Foundry deployment name |
| `PORT` | `3000` | Local server port |
| `HOST` | `127.0.0.1` | Listening interface |
| `DECISION_TIMEOUT_MS` | `10000` | Request timeout, 100–60000 ms |

Use `npm run dev` for Node's watch mode. Restart explicitly after editing `.env`. The app defaults to loopback access; it does not include public-user authentication or a deployment-level API spending budget.

## Verify

```powershell
npm run check
npm test
```

For browser regressions at desktop and 390 px mobile sizes:

```powershell
npx playwright install chromium
npm run test:browser
```

Browser checks launch an isolated offline server on port 3100, exercise gameplay and controls, capture screenshots under `test-results/`, and never use your Azure credentials.

To measure the configured deployment directly:

```powershell
npm run profile:latency
npm run profile:gameplay
```

These commands make real Foundry requests using `.env` and write measurements under `performance-results/`. The first separates local simulation time, input size/tokens, cold request time, and warm roundtrips. The second runs a deterministic 20-second game at 4× and reports model versus safety decisions; set `PROFILE_DURATION_MS` to change its duration. Neither starts the development server. Request latency includes network, provider routing, and inference; it is not a pure inference benchmark. A nearby Foundry resource using `GlobalStandard` can still route inference globally; see the [deployment guidance](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision#microsoft-decision-1-at-a-glance).

Tests use Node's built-in runner, a local mock Foundry endpoint, and real HTTP/WebSocket connections. They cover placement reachability, line clears, long-running local play, the request/authentication contract, invalid responses, API errors, cancellation, game isolation, and serving boundaries. No Azure credentials or billable calls are needed. A real Foundry deployment is required to measure actual model latency and playing quality.

```text
server.js          HTTP server and ws transport
src/tetris.js      Authoritative engine and candidate simulation
src/decision.js    Foundry request and response handling
src/session.js     Game lifecycle, async decisions, telemetry
public/            Vanilla HTML, CSS, and JS interface
test/              Engine, API, session, and integration tests
```
