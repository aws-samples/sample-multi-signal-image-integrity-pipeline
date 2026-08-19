# Review interface

A React single-page application built with the [Cloudscape Design System](https://cloudscape.design/).
It lists scored images, and opens one image at a time to show the evidence and the per-signal
findings.

## Build

```bash
npm ci && npm run build
```

The build writes to `dist/`, which the CDK stack uploads to the site bucket and serves through
Amazon CloudFront. Run the build before `cdk deploy`, because the deployment reads `dist/` as an
asset.

## Local development

```bash
npm run dev
```

The dev server needs a `public/config.json` pointing at a deployed stack, because sign-in and the
API both come from real resources:

```json
{
  "apiUrl": "https://<distribution-domain>/api",
  "region": "<region>",
  "userPoolId": "<UserPoolId output>",
  "userPoolClientId": "<UserPoolClientId output>"
}
```

Requests to a deployed API from `localhost` are cross-origin, so expect the browser to block them
unless you add your dev origin to the API's CORS configuration.

## How it fits together

`src/api.ts` holds everything that talks to AWS: it configures Amplify with the user pool from
`config.json`, exposes sign-in and sign-out, and attaches the Amazon Cognito ID token to every API
request. Uploads are the one exception. The API returns a presigned Amazon S3 URL, and the browser
PUTs to it without the Cognito header, because the URL signature is its own authorization.

`src/App.tsx` holds the interface: a sign-in form, the review queue table, and the per-image detail
view with the evidence switcher. `src/PipelineProgress.tsx` is the stepper shown while an analysis
runs.

Signal rationales and EXIF strings come from outside the application, so they are rendered as text
and never as markup.
