# PRISM for Figma — Backend

Express proxy server for the PRISM Figma plugin. Keeps your Leonardo API key
server-side and never exposes it to the browser.

## Setup

```bash
cp .env.example .env
# Add your Leonardo API key to .env
npm install
npm start
```

Server runs on `http://localhost:3002`

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Health check |
| GET | /api/balance | User token balance |
| POST | /api/generate | Start image generation |
| GET | /api/generation/:id | Poll generation status |
| DELETE | /api/generation/:id | Delete a generation |
| GET | /api/proxy-image?url= | Proxy Leonardo CDN images |
| GET | /api/library | User recent generations |
| POST | /api/magic-prompt | Spark Prompt enhancement |
| GET | /api/blueprints | List blueprint workflows |
| POST | /api/blueprint-execute | Run a blueprint |
| GET | /api/blueprint-result/:id | Poll blueprint result |

## Deploy to Render

1. Push this folder to a GitHub repo
2. Create a new Web Service on render.com
3. Set build command: `npm install`
4. Set start command: `npm start`
5. Add environment variable: `LEONARDO_API_KEY`
