import { Hono } from 'hono';
import type { AppVariables } from '../src/server/request-context.js';

/**
 * Monte un routeur C1 (qui lit c.get('workspace') / c.get('store') / …)
 * avec les variables d'une requête authentifiée. Les tests qui montent
 * un routeur directement (sans app.ts) passent par ici.
 */
export function mountScoped(
  router: Hono<{ Variables: AppVariables }>,
  vars: Partial<AppVariables> & { userId: string },
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use('*', async (c, next) => {
    c.set('userId', vars.userId);
    if (vars.workspace) c.set('workspace', vars.workspace);
    if (vars.store) c.set('store', vars.store);
    if (vars.connections) c.set('connections', vars.connections);
    if (vars.pages) c.set('pages', vars.pages);
    if (vars.computers) c.set('computers', vars.computers);
    await next();
  });
  app.route('/', router);
  return app;
}
