import type { ComputerService } from './computer-service.js';
import type { ConnectionService } from './connections.js';
import type { PageService } from './page-service.js';
import type { Store } from './store.js';
import type { WorkspaceStore } from './workspace.js';

/**
 * Contexte de requête (Phase C1) : le middleware de session (app.ts) y
 * dépose l'utilisateur authentifié + les stores À PORTÉE de cet
 * utilisateur. Les routes lisent ces stores (jamais les singletons
 * non liés) : toute lecture/écriture est alors filtrée par userId.
 */
export type AppVariables = {
  userId: string;
  /** C3 : le rôle de la session (pour les gardes Admin des providers). */
  role: 'admin' | 'user';
  workspace: WorkspaceStore;
  store: Store;
  connections: ConnectionService;
  pages: PageService;
  computers: ComputerService;
};
