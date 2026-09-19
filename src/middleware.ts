/**
 * PolyGraph Visualizer Middleware — mount in any Hono/Express app.
 *
 * Usage:
 *   import { vizMiddleware } from 'polygraph-viz/middleware';
 *   app.use('/graph', vizMiddleware({ path: './data' }));
 */

export function vizMiddleware(_config: { path?: string; url?: string }) {
  // TODO: implement as Hono middleware that serves the visualizer
  return async (_c: any, next: any) => {
    await next();
  };
}
