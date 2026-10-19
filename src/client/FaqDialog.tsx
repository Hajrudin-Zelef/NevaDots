import { X } from 'lucide-react';

/** Phase F (menu avatar → FAQ) : le contenu a été validé avec l'utilisateur. */
const FAQ: Array<{ q: string; a: string }> = [
  {
    q: 'C’est quoi un Dot ?',
    a: 'Un agent IA persistant : son propre ordinateur, ses espaces, sa mémoire, il travaille pour toi même quand tu n’es pas là.',
  },
  {
    q: 'C’est quoi la « Discussion principale » ?',
    a: 'La première conversation de ton compte. Les autres sont parallèles. Si tu la fermes, la prochaine créée devient la nouvelle principale.',
  },
  {
    q: 'Comment créer un compte ?',
    a: 'Seul un Admin peut : Paramètres → Comptes → Créer un compte. Il choisit ton rôle, tes providers/modèles, ta limite mensuelle, ton max de Dots.',
  },
  {
    q: 'J’ai oublié mon mot de passe ?',
    a: 'Demande à un Admin un code (transmis hors ligne), puis /reset : code + nouveau mot de passe. Code à usage unique, expire en 1 h.',
  },
  {
    q: 'C’est quoi la limite mensuelle ?',
    a: 'Le montant max (en $) que tes Dots peuvent consommer en modèles par mois. Atteinte, les nouveaux tours sont refusés (tu peux toujours relire tes conversations). Seul un Admin la modifie.',
  },
  {
    q: 'Pourquoi un modèle n’apparaît pas dans mon sélecteur ?',
    a: 'Ton compte n’a accès qu’aux providers/modèles assignés par l’Admin. Demande-lui de les modifier (Paramètres → Comptes).',
  },
  {
    q: 'Où sont mes données ?',
    a: 'Sur ton serveur, dans le conteneur (base SQLite locale). Rien ne part chez un tiers sauf les appels aux modèles configurés.',
  },
  {
    q: 'Comment supprimer mon compte ?',
    a: 'Demande à un Admin : tout est effacé (Dots, conversations, mémoire, fichiers), irréversible.',
  },
];

export function FaqDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close icon-button"
          aria-label="Fermer"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <span className="eyebrow">NEVADOTS</span>
        <h2 id="dialog-title">FAQ</h2>
        <div className="prefs-section">
          {FAQ.map((item) => (
            <div key={item.q} className="prefs-field">
              <span className="prefs-field-label">{item.q}</span>
              <span>{item.a}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
