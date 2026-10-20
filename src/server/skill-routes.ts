import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import type { AppVariables } from './request-context.js';
import type { SkillLibrary } from './skills-library.js';

/** Diagnostic + reindex de la bibliothèque de skills (host). */
export function skillRoutes(skills: SkillLibrary) {
  const app = new Hono<{ Variables: AppVariables }>();
  // Bundle d'un skill (tar.gz) : ticket à usage unique minté par load_skill.
  // Appelé par le conteneur du Dot via le bridge Docker ; exempté de session
  // dans app.ts, l'authentification EST le ticket.
  app.get('/skills/bundle', (c) => {
    const bound = skills.consumeBundle(c.req.query('ticket') ?? '');
    if (!bound) return c.json({ error: 'Invalid or expired ticket.' }, 401);
    const skill = skills.get(bound.skillId);
    if (!skill) return c.json({ error: 'Skill not found.' }, 404);
    const child = spawn('tar', ['-czf', '-', '-C', skill.dir, '.'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.on('error', () => {});
    return c.body(Readable.toWeb(child.stdout) as ReadableStream, 200, {
      'Content-Type': 'application/gzip',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  });
  // Diagnostic Admin : mint un ticket de bundle (30 s) pour vérifier le
  // transfert vers un conteneur sans passer par un tour de modèle.
  app.post('/skills/:id/ticket', (c) => {
    if (c.get('role') !== 'admin') return c.json({ error: 'Admin only.' }, 403);
    const id = decodeURIComponent(c.req.param('id'));
    if (!skills.get(id)) return c.json({ error: 'Skill not found.' }, 404);
    return c.json({
      id,
      ticket: skills.mintBundle(id, `admin:${c.get('userId')}`),
      expiresInMs: 30_000,
    });
  });
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
