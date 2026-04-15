# Deployment Guide

This app can stay live without your terminal open by deploying it to a hosted Node platform. You do not need a custom domain. A generated Railway or Render URL is enough to share with your friend.

## Best fit

- Railway: best overall if you want a clean always-on Node service and simple GitHub deploys.
- Render: good fallback and has a free web service tier, but free services spin down after idle time.

## Railway steps

1. Push this repo to GitHub.
2. Create a new project in Railway and connect the GitHub repo.
3. Deploy the repo as a Node service.
4. Add these environment variables in Railway:
   - `NODE_ENV=production`
   - `OPENAI_API_KEY=...`
   - `ASSISTANT_NAME=Fern`
   - `OPENAI_REALTIME_MODEL=gpt-realtime`
   - `OPENAI_REALTIME_VOICE=marin`
5. After Railway gives you a public URL, set:
   - `PUBLIC_BASE_URL=https://your-service.up.railway.app`
6. Redeploy once after `PUBLIC_BASE_URL` is added.

## Render steps

1. Push this repo to GitHub.
2. Create a new Web Service in Render from the repo.
3. Render can use the included `render.yaml`, or you can set:
   - Build command: `npm install`
   - Start command: `npm start`
4. Add the same environment variables listed above.
5. Set `PUBLIC_BASE_URL` to the Render service URL and redeploy.

## Phone number setup

1. Deploy the app first so `POST /api/openai/webhook` is publicly reachable.
2. In your OpenAI project, create a webhook pointing to:
   - `https://your-public-app-url/api/openai/webhook`
3. Save the webhook secret as `OPENAI_WEBHOOK_SECRET` in your deployment platform.
4. Use a SIP trunk provider such as Twilio.
5. Point the SIP trunk termination URI to:
   - `sip:$PROJECT_ID@sip.api.openai.com;transport=tls`
6. Assign a phone number to that SIP trunk.
7. Call the number and verify the webhook accepts the incoming call.

## Important behavior

- Localhost only works while your terminal is running the server.
- A deployed service keeps running after your terminal closes.
- A generated platform URL is enough. You do not need to buy a domain.
