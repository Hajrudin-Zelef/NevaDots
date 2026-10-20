import { Hono } from 'hono';
import type { AppVariables } from './request-context.js';
import type { SkillLibrary } from './skills-library.js';

/** Diagnostic + reindex de la bibliothèque de skills (host). */
export function skillRoutes(skills: SkillLibrary) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.get('/skills', (c) => {
    const query = (c.req.query('query') ?? '').trim();
    const raw = Number(c.req.query('limit') ?? 5);
    const limit = Number.isFinite(raw)
      ? Math.min(Math.max(Math.trunc(raw), 1), 10)
      : 5;
    return c.json({
      size: skills.size,
      skipped: skills.skippedCount,
      indexedAt: skills.lastLoadedAt,
      query,
      skills: query ? skills.search(query, limit) : skills.list(limit),
    });
  });
  // Instance-wide: réservé à l'Admin (le propriétaire bootstrap l'est).
  app.post('/skills/reindex', (c) => {
    if (c.get('role') !== 'admin') return c.json({ error: 'Admin only.' }, 403);
    const count = skills.reindex();
    return c.json({
      count,
      skipped: skills.skippedCount,
      indexedAt: skills.lastLoadedAt,
    });
  });
  return app;
}
