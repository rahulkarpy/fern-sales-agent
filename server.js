import "dotenv/config";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import WebSocket, { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 3000);

const assistantName = process.env.ASSISTANT_NAME || "Fern";
const defaultVoice = process.env.OPENAI_REALTIME_VOICE || "marin";
const publicBaseUrl = process.env.PUBLIC_BASE_URL || "";
const isProduction = process.env.NODE_ENV === "production";
const startupUrl = publicBaseUrl || `http://localhost:${port}`;
const publicWebSocketBaseUrl = startupUrl.replace(/^http/i, "ws");

const plantCatalog = [
  {
    name: "Monstera Deliciosa",
    light: "bright indirect light",
    petSafe: false,
    price: 42,
    pitch: "A dramatic, fast-growing statement plant with split leaves."
  },
  {
    name: "Snake Plant",
    light: "low to bright indirect light",
    petSafe: false,
    price: 28,
    pitch: "Extremely forgiving and perfect for first-time plant parents."
  },
  {
    name: "ZZ Plant",
    light: "low to medium light",
    petSafe: false,
    price: 34,
    pitch: "Glossy, resilient, and ideal for offices or lower-light homes."
  },
  {
    name: "Parlor Palm",
    light: "medium indirect light",
    petSafe: true,
    price: 31,
    pitch: "Soft, classic foliage that feels calm and works well indoors."
  },
  {
    name: "Pilea Peperomioides",
    light: "bright indirect light",
    petSafe: true,
    price: 26,
    pitch: "Playful coin-shaped leaves with a modern boutique feel."
  }
];

function buildRealtimeInstructions(channel = "web") {
  const channelGuidance =
    channel === "phone"
      ? "The caller is on a phone line, so keep responses slightly shorter and verbally signpost important details."
      : "The customer is on the website, so you can reference the visible page and product cards when useful.";

  const catalogSummary = plantCatalog
    .map(
      (plant) =>
        `${plant.name}: $${plant.price}, ${plant.light}, pet-safe=${plant.petSafe ? "yes" : "no"}, ${plant.pitch}`
    )
    .join(" | ");

  return [
    `You are ${assistantName}, an AI plant concierge for Verdant Studio.`,
    "Always identify yourself as an AI assistant early in the conversation.",
    "Your goal is to help people discover and confidently buy the right potted plant.",
    "Sound warm, quick, observant, and conversational rather than scripted.",
    "Ask one focused question at a time, listen carefully, and guide the customer toward a specific recommendation.",
    "When someone seems ready, confidently suggest a next step such as choosing a plant, adding accessories, or scheduling a follow-up.",
    "Never invent inventory, plant safety, or care facts beyond the catalog and general common-sense care advice.",
    "If asked about pet safety, be precise and conservative.",
    "Keep answers under 3 sentences unless the user asks for more detail.",
    channelGuidance,
    `Current catalog: ${catalogSummary}`
  ].join(" ");
}

function buildSessionConfig(channel = "web") {
  return {
    type: "realtime",
    model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
    instructions: buildRealtimeInstructions(channel),
    audio: {
      input: {
        noise_reduction: {
          type: channel === "phone" ? "far_field" : "near_field"
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 700,
          create_response: true,
          interrupt_response: true
        },
        transcription: {
          model: "gpt-4o-mini-transcribe",
          language: "en"
        }
      },
      output: {
        voice: defaultVoice
      }
    }
  };
}

function buildPhoneBridgeSessionConfig() {
  return {
    type: "realtime",
    model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
    instructions: buildRealtimeInstructions("phone"),
    audio: {
      input: {
        format: {
          type: "audio/pcmu"
        },
        noise_reduction: {
          type: "far_field"
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 700,
          create_response: true,
          interrupt_response: true
        },
        transcription: {
          model: "gpt-4o-mini-transcribe",
          language: "en"
        }
      },
      output: {
        format: {
          type: "audio/pcmu"
        },
        voice: defaultVoice
      }
    }
  };
}

function ensureOpenAiKey(res) {
  if (process.env.OPENAI_API_KEY) {
    return true;
  }

  res.status(500).json({
    error: "Missing OPENAI_API_KEY. Add it to .env before starting the server."
  });
  return false;
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : "Unknown error";
}

async function createRealtimeCall(sdp, channel = "web") {
  const form = new FormData();
  form.set("sdp", sdp);
  form.set("session", JSON.stringify(buildSessionConfig(channel)));

  const response = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: form
  });

  const answer = await response.text();
  if (!response.ok) {
    throw new Error(`Realtime call creation failed (${response.status}): ${answer}`);
  }

  return {
    sdpAnswer: answer,
    callId: response.headers.get("Location") || null
  };
}

function verifyOpenAiWebhook(requestBody, headers) {
  const secret = process.env.OPENAI_WEBHOOK_SECRET;
  if (!secret) {
    return true;
  }

  const timestamp = headers["webhook-timestamp"];
  const signatureHeader = headers["webhook-signature"];

  if (!timestamp || !signatureHeader) {
    return false;
  }

  const signedPayload = `${timestamp}.${requestBody}`;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("base64");
  const signatures = String(signatureHeader)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("v1,"))
    .map((entry) => entry.slice(3));

  return signatures.some((signature) => {
    try {
      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  });
}

async function acceptIncomingSipCall(callId) {
  const acceptResponse = await fetch(`https://api.openai.com/v1/realtime/calls/${callId}/accept`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(buildSessionConfig("phone"))
  });

  if (!acceptResponse.ok) {
    const details = await acceptResponse.text();
    throw new Error(`Failed to accept SIP call (${acceptResponse.status}): ${details}`);
  }
}

function monitorSipCall(callId) {
  const socket = new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${callId}`, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    }
  });

  socket.on("open", () => {
    socket.send(
      JSON.stringify({
        type: "response.create",
        response: {
          instructions:
            `Greet the caller as ${assistantName}, say you are an AI plant concierge at Verdant Studio, ` +
            "and ask what kind of space or plant problem they are shopping for today."
        }
      })
    );
  });

  socket.on("message", (message) => {
    try {
      const event = JSON.parse(message.toString());
      const importantTypes = new Set([
        "response.created",
        "response.done",
        "error",
        "conversation.item.created"
      ]);

      if (importantTypes.has(event.type)) {
        console.log("[sip]", callId, event.type);
      }
    } catch (error) {
      console.error("Failed to parse SIP sideband event:", error);
    }
  });

  socket.on("error", (error) => {
    console.error("SIP sideband socket error:", error);
  });
}

function createTwimlStreamResponse() {
  const streamUrl = `${publicWebSocketBaseUrl}/api/twilio/media-stream`;
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<Response>",
    "  <Connect>",
    `    <Stream url="${streamUrl}" />`,
    "  </Connect>",
    "</Response>"
  ].join("");
}

function sendTwilioMedia(ws, streamSid, payload) {
  if (!streamSid || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(
    JSON.stringify({
      event: "media",
      streamSid,
      media: {
        payload
      }
    })
  );
}

function sendTwilioClear(ws, streamSid) {
  if (!streamSid || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(
    JSON.stringify({
      event: "clear",
      streamSid
    })
  );
}

function attachTwilioMediaBridge(clientSocket) {
  let twilioStreamSid = null;
  let openAiSocket = null;
  let openAiReady = false;
  let greetingSent = false;

  const closeBoth = () => {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close();
    }

    if (openAiSocket && openAiSocket.readyState === WebSocket.OPEN) {
      openAiSocket.close();
    }
  };

  openAiSocket = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime", {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    }
  });

  openAiSocket.on("open", () => {
    openAiReady = true;
    openAiSocket.send(
      JSON.stringify({
        type: "session.update",
        session: buildPhoneBridgeSessionConfig()
      })
    );
  });

  openAiSocket.on("message", (rawMessage) => {
    try {
      const event = JSON.parse(rawMessage.toString());

      if (event.type === "session.updated" && !greetingSent) {
        greetingSent = true;
        openAiSocket.send(
          JSON.stringify({
            type: "response.create",
            response: {
              audio: {
                output: {
                  format: {
                    type: "audio/pcmu"
                  }
                }
              },
              instructions:
                `Greet the caller as ${assistantName}, say you are an AI plant concierge at Verdant Studio, ` +
                "and ask what kind of room, light, or plant problem they are shopping for today."
            }
          })
        );
      }

      if (event.type === "response.output_audio.delta" && event.delta) {
        sendTwilioMedia(clientSocket, twilioStreamSid, event.delta);
      }

      if (event.type === "input_audio_buffer.speech_started") {
        sendTwilioClear(clientSocket, twilioStreamSid);
      }

      if (event.type === "error") {
        console.error("OpenAI phone bridge error:", event.error?.message || event);
      }
    } catch (error) {
      console.error("Failed to parse OpenAI phone bridge event:", error);
    }
  });

  openAiSocket.on("close", () => {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close();
    }
  });

  openAiSocket.on("error", (error) => {
    console.error("OpenAI bridge socket error:", error);
  });

  clientSocket.on("message", (rawMessage) => {
    try {
      const message = JSON.parse(rawMessage.toString());

      if (message.event === "start") {
        twilioStreamSid = message.start?.streamSid ?? null;
        console.log("Twilio media stream started:", twilioStreamSid);
        return;
      }

      if (message.event === "media" && openAiReady && message.media?.payload) {
        openAiSocket.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: message.media.payload
          })
        );
        return;
      }

      if (message.event === "stop") {
        closeBoth();
      }
    } catch (error) {
      console.error("Failed to parse Twilio media event:", error);
    }
  });

  clientSocket.on("close", () => {
    if (openAiSocket && openAiSocket.readyState === WebSocket.OPEN) {
      openAiSocket.close();
    }
  });

  clientSocket.on("error", (error) => {
    console.error("Twilio media socket error:", error);
  });
}

if (isProduction) {
  app.set("trust proxy", 1);
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    assistantName,
    phoneWebhookReady: Boolean(process.env.OPENAI_WEBHOOK_SECRET),
    publicBaseUrl
  });
});

app.get("/api/catalog", (_req, res) => {
  res.json({
    assistantName,
    plants: plantCatalog
  });
});

app.post("/api/twilio/voice", (_req, res) => {
  res.type("text/xml").send(createTwimlStreamResponse());
});

app.get("/api/diagnostics/realtime", async (_req, res) => {
  if (!ensureOpenAiKey(res)) {
    return;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        session: buildSessionConfig("web")
      })
    });

    const raw = await response.text();
    let parsed = null;

    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }

    if (!response.ok) {
      res.status(response.status).json({
        ok: false,
        stage: "client_secret",
        details: parsed
      });
      return;
    }

    res.json({
      ok: true,
      stage: "client_secret",
      expiresAt: parsed.expires_at ?? null
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      stage: "client_secret",
      details: safeErrorMessage(error)
    });
  }
});

app.post("/api/realtime/call", express.text({ type: "application/sdp" }), async (req, res) => {
  if (!ensureOpenAiKey(res)) {
    return;
  }

  if (!req.body) {
    res.status(400).json({ error: "Missing SDP offer in request body." });
    return;
  }

  try {
    const { sdpAnswer, callId } = await createRealtimeCall(req.body, "web");

    if (callId) {
      res.setHeader("X-OpenAI-Call-Id", callId);
    }

    res.type("application/sdp").send(sdpAnswer);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: safeErrorMessage(error)
    });
  }
});

app.post("/api/openai/webhook", express.text({ type: "application/json" }), async (req, res) => {
  if (!ensureOpenAiKey(res)) {
    return;
  }

  if (!verifyOpenAiWebhook(req.body, req.headers)) {
    res.status(400).json({ error: "Invalid webhook signature." });
    return;
  }

  let event;

  try {
    event = JSON.parse(req.body);
  } catch {
    res.status(400).json({ error: "Invalid JSON payload." });
    return;
  }

  if (event.type !== "realtime.call.incoming") {
    res.status(200).json({ ignored: true });
    return;
  }

  try {
    await acceptIncomingSipCall(event.data.call_id);
    monitorSipCall(event.data.call_id);
    res.status(200).json({ accepted: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

app.use((err, _req, res, _next) => {
  console.error("Unhandled Express error:", err);
  res.status(500).json({ error: "Internal server error." });
});

const server = http.createServer(app);
const twilioMediaServer = new WebSocketServer({ noServer: true });

twilioMediaServer.on("connection", (socket) => {
  if (!process.env.OPENAI_API_KEY) {
    socket.close();
    return;
  }

  attachTwilioMediaBridge(socket);
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, "http://localhost");

  if (url.pathname !== "/api/twilio/media-stream") {
    socket.destroy();
    return;
  }

  twilioMediaServer.handleUpgrade(request, socket, head, (ws) => {
    twilioMediaServer.emit("connection", ws, request);
  });
});

server.listen(port, () => {
  console.log(`Fern sales agent listening on ${startupUrl}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down gracefully...`);
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
