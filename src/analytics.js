import { inject } from '@vercel/analytics';

// Analytics is a deployment feature: the production client loads
// /_vercel/insights/script.js, which only exists when served by Vercel.
// Injecting anywhere else (vite preview of a release build, dev server) is a
// guaranteed failed-resource console error on every load (campaign W2-D/B5),
// so injection is gated to the hosts where the endpoint actually exists.
const DEPLOYED_HOST_RE = /(^|\.)(?:vercel\.app|kevinliu\.studio)$/i;
const hostname = typeof location !== 'undefined' ? location.hostname : '';
if (DEPLOYED_HOST_RE.test(hostname)) {
  inject({
    mode: import.meta.env.PROD ? 'production' : 'development',
  });
}
