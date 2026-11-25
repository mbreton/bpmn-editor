// Administration des comptes et invitations : une seule logique (et les mêmes garde-fous) pour
// l'interface web et le connecteur MCP. Chaque fonction renvoie { error, status } ou le résultat.
import { createHash, randomBytes } from 'node:crypto';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const INVITE_DAYS = 7;
const tokenHash = t => createHash('sha256').update(String(t)).digest('hex');
const fail = (status, error) => ({ status, error });
const validEmail = e => typeof e === 'string' && EMAIL_RE.test(e.trim()) && e.length <= 200;
const validName = n => typeof n === 'string' && n.trim().length >= 2 && n.length <= 80;

export function createAccounts({ db, auth }) {
  const newToken = () => { const token = randomBytes(24).toString('base64url'); return { token, hash: tokenHash(token), expiresAt: Date.now() + INVITE_DAYS * 86400e3 }; };

  return {
    listUsers: () => db.listUsers(),

    /** Modifie le statut (active, disabled, pending) ou le rôle (user, admin) d'un compte. */
    updateUser(admin, uid, { status, role } = {}) {
      const target = db.userById(uid);
      if (!target) return fail(404, 'Compte introuvable.');
      if (status !== undefined && !['active', 'disabled', 'pending'].includes(status)) return fail(400, 'Statut invalide.');
      if (role !== undefined && !['user', 'admin'].includes(role)) return fail(400, 'Rôle invalide.');
      if (target.id === admin.id && ((status && status !== 'active') || role === 'user')) return fail(400, 'Vous ne pouvez pas retirer vos propres droits.');
      const fields = { status, role };
      if (status === 'active' && target.status === 'pending') fields.approvedBy = admin.id;
      return { user: db.updateUser(target.id, fields) };
    },

    deleteUser(admin, uid) {
      if (uid === admin.id) return fail(400, 'Vous ne pouvez pas supprimer votre propre compte.');
      const target = db.userById(uid);
      if (!target || !db.deleteUser(uid)) return fail(404, 'Compte introuvable.');
      return { user: target };
    },

    listInvitations: () => db.listInvitations(),

    /** Invitation pour un e-mail (remplace une invitation en cours pour la même adresse). Le jeton n'est rendu qu'ici. */
    invite(admin, { email, name } = {}) {
      if (!validEmail(email)) return fail(400, 'Adresse e-mail invalide.');
      if (name !== undefined && name !== null && name !== '' && !validName(name)) return fail(400, 'Nom : 2 à 80 caractères.');
      if (db.userAuthByEmail(email.trim())) return fail(409, 'Un compte existe déjà avec cette adresse.');
      const t = newToken();
      const id = db.createInvitation({ email: email.trim(), name: name?.trim() || null, tokenHash: t.hash, createdBy: admin.id, expiresAt: t.expiresAt });
      return { invitation: { id, email: email.trim(), token: t.token, expiresAt: t.expiresAt } };
    },

    renewInvitation(id) {
      const inv = db.invitationById(id);
      if (!inv || inv.used_at) return fail(404, 'Invitation introuvable ou déjà utilisée.');
      const t = newToken();
      db.renewInvitation(inv.id, t.hash, t.expiresAt);
      return { invitation: { id: inv.id, email: inv.email, token: t.token, expiresAt: t.expiresAt } };
    },

    cancelInvitation: id => db.deleteInvitation(id) ? { ok: true } : fail(404, 'Invitation introuvable.'),

    /** Lien d'invitation : pour qui il est, s'il est encore valable. */
    openInvitation(token) {
      const inv = typeof token === 'string' && token.length <= 100 ? db.invitationByToken(tokenHash(token)) : null;
      if (!inv) return fail(404, 'Ce lien d\'invitation n\'est pas valable. Demandez-en un nouveau à l\'administrateur.');
      if (inv.used_at) return fail(410, 'Ce lien d\'invitation a déjà été utilisé : connectez-vous avec votre e-mail et votre mot de passe.');
      if (inv.expires_at < Date.now()) return fail(410, 'Ce lien d\'invitation a expiré. Demandez-en un nouveau à l\'administrateur.');
      return { inv };
    },

    /** La personne invitée choisit son nom et son mot de passe : compte créé actif. */
    acceptInvitation(token, { name, password } = {}) {
      const r = this.openInvitation(token);
      if (r.error) return r;
      if (!validName(name)) return fail(400, 'Nom requis (2 à 80 caractères).');
      if (typeof password !== 'string' || password.length < 8 || password.length > 200) return fail(400, 'Mot de passe : 8 caractères minimum.');
      if (db.userAuthByEmail(r.inv.email)) return fail(409, 'Un compte existe déjà avec cette adresse : connectez-vous.');
      const user = db.tx(() => {
        if (!db.useInvitation(r.inv.id)) return null;
        const created = db.createUser({ email: r.inv.email, name: name.trim(), passwordHash: auth.hashPassword(password), status: 'active' });
        return r.inv.created_by ? db.updateUser(created.id, { approvedBy: r.inv.created_by }) : created;
      });
      return user ? { user } : fail(410, 'Ce lien d\'invitation a déjà été utilisé.');
    }
  };
}
