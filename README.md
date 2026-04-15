# Verdant Studio Voice Agent

A natural-sounding plant sales agent for the web and phone, powered by the OpenAI Realtime API.

## What this includes

- A browser voice experience using WebRTC and `gpt-realtime`
- A plant catalog and sales-oriented assistant prompt
- An OpenAI webhook endpoint for inbound SIP phone calls
- A lightweight sideband WebSocket connection that triggers the first greeting on phone calls

## Before you run it

1. Create a `.env` file from `.env.example`.
2. Add your `OPENAI_API_KEY`.
3. If you want phone support, also add `OPENAI_WEBHOOK_SECRET`.

## Run locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

## Website voice calls

This app uses the official OpenAI WebRTC flow: the browser creates an SDP offer, your server forwards it to `POST /v1/realtime/calls`, and the server returns the SDP answer. OpenAI recommends WebRTC for browser voice experiences and documents `POST /v1/realtime/calls` for this flow:

- [Realtime API with WebRTC](https://platform.openai.com/docs/guides/realtime-webrtc)
- [Realtime calls API reference](https://platform.openai.com/docs/api-reference/realtime?api-mode=responses)

## Phone number setup

OpenAI now supports SIP directly for Realtime phone calls. The cleanest production setup is:

1. Buy or use a number from a SIP trunking provider such as Twilio.
2. Point the SIP trunk at `sip:$PROJECT_ID@sip.api.openai.com;transport=tls`.
3. Configure an OpenAI project webhook that targets `POST /api/openai/webhook`.
4. Store the webhook secret in `OPENAI_WEBHOOK_SECRET`.

When OpenAI sends a `realtime.call.incoming` webhook, this app accepts the call and applies the same plant-sales instructions used on the website. OpenAI documents this SIP flow here:

- [Realtime API with SIP](https://platform.openai.com/docs/guides/realtime-sip)
- [Realtime server-side controls](https://platform.openai.com/docs/guides/realtime-server-controls)
- [Incoming SIP webhook event](https://platform.openai.com/docs/api-reference/webhook-events/realtime/call/incoming?lang=node.js)

## Deployment

If you want the site to stay live after your terminal closes, deploy it to Railway or Render. A generated deployment URL is enough; you do not need to buy a domain for this project.

- [Deployment guide](./DEPLOYMENT.md)
- [Railway deployment docs](https://docs.railway.com/cli/deploying)
- [Render free web services](https://render.com/docs/free)

## Important note

This implementation is designed to sound natural and polished, but it intentionally identifies itself as an AI assistant rather than pretending to be human.
