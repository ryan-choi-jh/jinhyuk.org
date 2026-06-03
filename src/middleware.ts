import { defineMiddleware } from 'astro:middleware';

// Keystatic builds its GitHub OAuth redirect_uri from the request host, but on
// Vercel the function sees an internal "localhost" host instead of the real
// domain — so login would bounce to https://localhost and fail. We rewrite the
// OAuth routes to use Vercel's forwarded host/proto headers.
// Workaround for https://github.com/Thinkmill/keystatic/issues/1022
export const onRequest = defineMiddleware(async (context, next) => {
  const isOAuthRoute = context.url.pathname.includes('/api/keystatic/github/');

  if (isOAuthRoute) {
    const forwardedHost = context.request.headers.get('x-forwarded-host');
    const forwardedProto =
      context.request.headers.get('x-forwarded-proto') ?? 'https';

    if (forwardedHost) {
      const correctUrl = new URL(context.url);
      correctUrl.protocol = forwardedProto;
      correctUrl.host = forwardedHost;

      const newRequest = new Request(correctUrl.toString(), {
        method: context.request.method,
        headers: context.request.headers,
        body: context.request.body,
        // @ts-ignore - duplex is required when a body stream is present
        duplex: 'half',
      });

      try {
        Object.defineProperty(context, 'url', {
          value: correctUrl,
          configurable: true,
        });
        Object.defineProperty(context, 'request', {
          value: newRequest,
          configurable: true,
        });
      } catch {
        // If the context fields are read-only on this Astro version, fall
        // through — login simply keeps the default behavior.
      }
    }
  }

  return next();
});
