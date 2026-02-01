# Cross-Origin-Opener-Policy (COOP) Fix Guide

## Problem
When attempting to login with Google OAuth on the hosted Vercel/Render deployments, you encountered this error:
```
Cross-Origin-Opener-Policy policy would block the window.postMessage call.
```

## Root Cause
Google OAuth uses `window.postMessage` to communicate between the popup window and your application. The Cross-Origin-Opener-Policy (COOP) header was blocking this communication, preventing the login from completing successfully.

## Solution Implemented
The fix involves setting the COOP header to `same-origin-allow-popups` instead of the default restrictive policy. This allows popups from the same origin to communicate via `postMessage`.

### Changes Made

#### 1. Vite Configuration (`client/vite.config.js`)
Added headers for local development and preview:
```javascript
server: {
  headers: {
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    "Cross-Origin-Embedder-Policy": "unsafe-none",
  },
},
preview: {
  headers: {
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    "Cross-Origin-Embedder-Policy": "unsafe-none",
  },
},
```

#### 2. Vercel Configuration (`client/vercel.json`)
Updated headers configuration:
```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        {
          "key": "Cross-Origin-Opener-Policy",
          "value": "same-origin-allow-popups"
        },
        {
          "key": "Cross-Origin-Embedder-Policy",
          "value": "unsafe-none"
        }
      ]
    }
  ]
}
```

#### 3. Render Configuration (`render.yaml`)
Created new Render configuration file with proper headers:
```yaml
services:
  - type: web
    name: insightcrm-client
    env: static
    buildCommand: cd client && npm install && npm run build
    publishPath: client/dist
    headers:
      - source: /*
        headers:
          - key: Cross-Origin-Opener-Policy
            value: same-origin-allow-popups
          - key: Cross-Origin-Embedder-Policy
            value: unsafe-none
```

#### 4. Static Headers File (`client/public/_headers`)
Added Netlify-style headers file for additional compatibility:
```
/*
  Cross-Origin-Opener-Policy: same-origin-allow-popups
  Cross-Origin-Embedder-Policy: unsafe-none
```

## Deployment Instructions

### For Vercel
1. Push these changes to your GitHub repository
2. Vercel will automatically detect the changes in `vercel.json` and redeploy
3. Alternatively, trigger a manual redeploy from the Vercel dashboard

### For Render
1. Push these changes to your GitHub repository
2. If you haven't connected the `render.yaml` file yet:
   - Go to your Render dashboard
   - Select your web service
   - Click "Settings" → "Build & Deploy"
   - Ensure the "Root Directory" is set correctly (should be empty or `/`)
   - The `render.yaml` file will be automatically detected
3. Trigger a manual deploy if needed

### Verification
After deployment, verify the fix by:
1. Opening your hosted application
2. Attempting to login with Google
3. The login should complete without the COOP error

## Security Considerations
- `same-origin-allow-popups` is a secure setting that allows popups from the same origin
- This is the recommended setting for applications using OAuth with popup windows
- The `Cross-Origin-Embedder-Policy: unsafe-none` ensures no restrictions on cross-origin embedding

## Additional Notes
- These changes only affect the client-side application
- No changes were needed to the server-side code
- The fix is backward compatible and won't affect existing functionality
