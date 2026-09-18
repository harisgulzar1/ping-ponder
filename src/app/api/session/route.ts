import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Mints the ephemeral key the browser uses to open its WebRTC session.
//
// The key-minting endpoint changed between the beta and GA realtime APIs, and
// the two return *different shapes*:
//   GA:   POST /v1/realtime/client_secrets -> { value, expires_at, session }
//   beta: POST /v1/realtime/sessions       -> { client_secret: { value, ... } }
//
// The client only ever knew the nested beta shape, so against a GA account the
// secret was present but unreadable. We probe GA first, fall back to beta, and
// normalize to the nested shape either way. The response carries `endpoint` so
// you can see which one your account actually serves -- once you know, delete
// the branch that loses.

/** Override in .env if your account serves a different realtime model. */
const MODEL = process.env.REALTIME_MODEL || "gpt-realtime-2.1";

interface Attempt {
  endpoint: string;
  status: number;
  body: unknown;
}

async function post(url: string, apiKey: string, body: unknown, beta: boolean) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(beta ? { "OpenAI-Beta": "realtime=v1" } : {}),
    },
    body: JSON.stringify(body),
  });
  return { response, data: await response.json().catch(() => null) };
}

/** GA puts the secret at the top level; beta nests it under client_secret. */
function extractSecret(data: any): string | null {
  if (typeof data?.value === "string") return data.value;
  if (typeof data?.client_secret?.value === "string") return data.client_secret.value;
  return null;
}

export async function GET() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("[session] OPENAI_API_KEY is not set");
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not set on the server." },
      { status: 500 },
    );
  }

  const attempts: Attempt[] = [];

  const candidates = [
    {
      endpoint: "/v1/realtime/client_secrets",
      url: "https://api.openai.com/v1/realtime/client_secrets",
      body: { session: { type: "realtime", model: MODEL } },
      beta: false,
    },
    {
      endpoint: "/v1/realtime/sessions",
      url: "https://api.openai.com/v1/realtime/sessions",
      body: { model: MODEL },
      beta: true,
    },
  ];

  for (const candidate of candidates) {
    try {
      const { response, data } = await post(
        candidate.url,
        apiKey,
        candidate.body,
        candidate.beta,
      );
      const secret = extractSecret(data);

      if (response.ok && secret) {
        console.log(
          `[session] minted key via ${candidate.endpoint} for model ${MODEL}`,
        );
        return NextResponse.json({
          // Normalized to the shape the client expects, whichever API answered.
          client_secret: { value: secret },
          model: MODEL,
          endpoint: candidate.endpoint,
        });
      }

      attempts.push({
        endpoint: candidate.endpoint,
        status: response.status,
        body: data,
      });
      console.error(`[session] ${candidate.endpoint} failed`, {
        status: response.status,
        body: data,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({ endpoint: candidate.endpoint, status: 0, body: message });
      console.error(`[session] ${candidate.endpoint} threw`, message);
    }
  }

  // Both failed. Hand the upstream errors to the browser so the cause is
  // visible without digging through server logs.
  return NextResponse.json(
    {
      error: `Could not mint an ephemeral key for model "${MODEL}".`,
      model: MODEL,
      attempts,
    },
    { status: 502 },
  );
}
