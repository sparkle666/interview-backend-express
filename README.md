# Interview Helper — SaaS Backend

Express + TypeScript backend that holds all AI logic and API keys server-side.
The Electron app sends screenshots/text here and gets answers back.

---

## Project structure

```
src/
├── index.ts                  # Express app entry point
├── types/index.ts            # Shared TypeScript types
├── middleware/
│   └── auth.ts               # JWT verification, token issuance
├── routes/
│   ├── ai.ts                 # All AI endpoints
│   └── auth.ts               # Token issuance / profile
└── services/
    ├── aiService.ts          # Extracted AI logic (ProcessingHelper + friends)
    └── usageTracker.ts       # Per-user daily usage enforcement
```

---

## Quick start

```bash
cp .env.example .env
# Fill in your API keys and JWT_SECRET in .env

npm install
npm run dev          # Development with hot reload
npm run build        # Compile TypeScript
npm start            # Run compiled output
```

---

## API endpoints

### Auth

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/token` | Issue a JWT (dev/admin only) |
| GET  | `/api/auth/me`    | Verify token, see tier + usage |

### AI (all require `Authorization: Bearer <token>`)

| Method | Path | Credits | Description |
|--------|------|---------|-------------|
| POST | `/api/ai/extract`           | 0 | Screenshots → problem info |
| POST | `/api/ai/solve`             | 1 | Problem info → solution |
| POST | `/api/ai/process`           | 1 | Screenshots → problem + solution (combined) |
| POST | `/api/ai/debug`             | 1 | Error screenshots → debug analysis |
| POST | `/api/ai/transcribe`        | 0 | Audio → text |
| POST | `/api/ai/answer-suggestions`| 0 | Question → 3 answer suggestions |
| GET  | `/api/ai/usage`             | — | Check remaining credits today |

---

## Tier limits (daily solutions)

| Tier | Default limit | Env var |
|------|-------------|---------|
| free | 3 | `TIER_FREE_MONTHLY_LIMIT` |
| starter | 20 | `TIER_STARTER_MONTHLY_LIMIT` |
| pro | 100 | `TIER_PRO_MONTHLY_LIMIT` |
| legend | ∞ | `TIER_LEGEND_MONTHLY_LIMIT` |

Limits reset at midnight UTC. Change them any time via env vars without redeploying.

---

## Issuing a token (development)

```bash
curl -X POST http://localhost:3000/api/auth/token \
  -H "Content-Type: application/json" \
  -d '{"userId":"user_123","email":"test@example.com","tier":"pro"}'
```

Returns `{ token, tier, userId, email }`. Store the token in the Electron app
(e.g. in your `ConfigHelper`) and send it as `Authorization: Bearer <token>`.

---

## Wiring the Electron app to the backend

In the Electron app, replace the direct AI calls in `ProcessingHelper.ts`
with HTTP requests to this backend. The simplest approach:

```typescript
// electron/BackendClient.ts  (new file in the app)
import axios from "axios";
import { configHelper } from "./ConfigHelper";

const BACKEND_URL = "https://your-backend.example.com"; // or localhost:3000 in dev

export async function processScreenshots(
  images: string[],         // base64 PNGs already read from disk
  language: string,
  provider: string,
  extractionModel: string,
  solutionModel: string,
  conversationContext?: string
) {
  const token = configHelper.getBackendToken(); // store token in config
  const res = await axios.post(
    `${BACKEND_URL}/api/ai/process`,
    { images, language, provider, extractionModel, solutionModel, conversationContext },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.data; // { problemInfo, solution, usage }
}
```

Then in `ProcessingHelper.ts`, replace the big if/else AI blocks with a
single call to `processScreenshots(...)`.

---

## Does this break stealth mode?

**No.** The stealth features (setContentProtection, invisible window, no taskbar icon)
are all Electron window-level settings. Network requests from the main process
are invisible to screen recorders — they happen in the background Node.js process,
not in any visible window. The app will look and behave identically to the user.

---

## Production deployment

1. Deploy to Railway, Render, Fly.io, or any Node.js host
2. Set all env vars in the hosting dashboard
3. Set `ALLOWED_ORIGINS` to lock CORS to your app's origin
4. Replace the in-memory `usageTracker` with Redis or a database for persistence
   across restarts (the interface is unchanged — just swap the implementation)
5. Replace `POST /api/auth/token` with your real payment/auth flow
   (Stripe webhook → set tier → `issueToken(userId, email, tier)`)
