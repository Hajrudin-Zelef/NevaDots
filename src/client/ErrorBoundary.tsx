import { Component, type ReactNode } from 'react';

/**
 * Filet de sécurité racine : un composant qui plante n'emporte plus
 * toute la page (écran blanc). L'erreur est journalisée par React dans
 * la console ; l'utilisateur voit un message et peut recharger.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div role="alert" className="error-boundary">
          <h2>Something went wrong.</h2>
          <p>Reload the page to try again.</p>
        </div>
      );
    }
    return this.props.children;
  }
}
