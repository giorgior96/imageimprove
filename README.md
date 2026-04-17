# imageimprove frontend

Frontend-only Vite + React app for the ImageImprove wizard.

## Required env for Vercel

```bash
VITE_API_BASE_URL=/api
```

`vercel.json` proxies `/api/*` to the backend running on the VPS.

## Setup

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```
