# Éditeur BPMN

Éditeur BPMN 2.0 collaboratif et auto-hébergé, en français. Il est construit sur [bpmn-js](https://bpmn.io), une bibliothèque open source sous licence MIT. Les diagrammes sont versionnés dans un dépôt **Git**.

- **Comptes** : n'importe qui peut créer un compte, mais il faut qu'un administrateur le valide. Un compte validé accède à tous les diagrammes. Pour partager un diagramme, il suffit d'envoyer l'adresse de sa page.
- **Git** : un fichier `.bpmn` par diagramme et un commit par enregistrement, avec la personne connectée comme auteur. L'historique permet de consulter et de restaurer chaque version. On peut ajouter un dépôt distant (GitHub, GitLab…) : il est cloné au démarrage, récupéré régulièrement, et chaque enregistrement y est poussé.
- **Édition** : une seule personne modifie un diagramme à la fois, grâce à un verrou. Les autres voient qui modifie, et récupèrent la nouvelle version une fois qu'elle est enregistrée.
- **Propriétés** en français : délais (ISO 8601 traduit en clair), événements interrompants ou non, erreurs, messages, conditions sur les flux sortants des passerelles, documentation. Chaque élément affiche une aide contextuelle, et un contrôle de cohérence passe sur tout le diagramme.
- **Assistant IA conversationnel** : on discute du diagramme par écrit ou à la voix, la réponse s'affiche au fil de l'eau. Ensuite, l'IA propose des **modifications une par une**. Pour chacune, l'éditeur zoome sur la zone concernée, explique pourquoi et ce que ça apporte, et on accepte ou on refuse.
- **Centre d'aide** : recherche par intention (« relancer », « si / sinon »…), avec une vignette, une explication et l'insertion directe dans le diagramme.
- **Simulation pas à pas** : « Étape suivante » démarre le jeton, puis le fait avancer élément par élément. Quand plusieurs événements sont possibles (réponse reçue ou délai écoulé), elle demande lequel se produit.
- Le **panneau latéral** est redimensionnable. **Export** en `.bpmn`, SVG et PNG.

## Déploiement sur Coolify

1. **New resource → Public/Private repository** : choisissez ce dépôt, branche `main`, build pack **Dockerfile**.
2. **Ports Exposes : `3000`**, puis associez un domaine. **Passez en HTTPS dès que possible** : en HTTP, les mots de passe circulent en clair et la dictée vocale est désactivée par le navigateur.
3. **Stockage persistant** : montez un volume sur `/data`. Il contient la base SQLite (comptes, index, verrous) et le dépôt Git local (`/data/repo`).
4. Variables d'environnement (voir `.env.example`) :

| Variable | Rôle |
|---|---|
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Compte administrateur, créé ou mis à jour à chaque démarrage. L'identifiant vaut `admin` par défaut. |
| `GIT_REMOTE_URL` | Facultatif. Dépôt distant, par exemple `https://x-access-token:<jeton>@github.com/org/diagrammes.git` avec un jeton fine-grained qui a le droit *Contents: read & write*. Pour SSH, montez une clé et utilisez `git@…`. |
| `GIT_BRANCH`, `GIT_SUBDIR`, `GIT_SYNC_INTERVAL` | Branche (`main`), dossier des diagrammes dans le dépôt (`diagrams`), intervalle de récupération en secondes (300). |
| `LLM_API_KEY` | Clé du fournisseur IA. Sans clé, l'assistant est désactivé. |
| `LLM_PROVIDER`, `LLM_MODEL`, `LLM_BASE_URL` | `anthropic` (par défaut, modèle `claude-sonnet-5-5`) ou `openai` pour toute API compatible `/chat/completions` en streaming : LiteLLM, Scaleway, Mistral, vLLM… |
| `COOKIE_SECURE` | `auto` par défaut : le cookie de session est marqué `Secure` seulement en HTTPS. |

Le healthcheck répond sur `GET /healthz`.

**Mise à jour depuis la version précédente** : au premier démarrage, les diagrammes et les versions stockés dans l'ancienne base SQLite sont repris dans Git, avec leurs auteurs et leurs dates d'origine. Les liens de partage disparaissent : chaque personne crée maintenant son compte. Sans `ADMIN_EMAIL`, l'administrateur se connecte avec l'identifiant `admin` et le même `ADMIN_PASSWORD`.

## Démarrage en local

```bash
npm install
cp .env.example .env       # renseigner ADMIN_PASSWORD (et LLM_API_KEY pour l'assistant)
npm run build
node --env-file=.env server/index.js     # → http://localhost:3000 (git doit être installé)
```

En développement : `node --env-file=.env --watch server/index.js` et `npx vite` (http://localhost:5173). Pour lancer les tests de l'API (comptes, Git local et distant, migration, assistant) : `npm test`.

## Comment fonctionne l'assistant

L'IA reçoit le diagramme à jour à chaque message, sans les coordonnées, ce qui le rend plus léger et plus rapide. Elle ne renvoie jamais de XML. Elle renvoie une liste de modifications, et chacune est une suite d'**opérations** (`append`, `insert`, `attach`, `connect`, `update`, `set_timer`, `set_condition`…). L'éditeur les applique avec les commandes de bpmn-js : la mise en page des nouveaux éléments est calculée par l'éditeur, chaque modification refusée est annulée, et un Ctrl+Z reste possible après la revue. Une modification qui référence un élément introuvable est signalée « non applicable », puis la revue passe à la suivante. Le résultat de la revue (modifications acceptées et refusées) est transmis à l'IA avec le message suivant.

## Architecture

```
server/
  app.js        routes : comptes, diagrammes, verrou, historique, assistant (flux SSE)
  auth.js       comptes (scrypt), sessions signées, administrateur défini par l'environnement
  git.js        dépôt Git : écriture + commit par auteur, mv/rm, log --follow, clone/pull --rebase/push
  diagrams.js   index SQLite ↔ fichiers du dépôt, réindexation, migration de l'ancien stockage
  ai.js         relais LLM en streaming (Anthropic / compatible OpenAI), prompt et format des opérations
web/src/
  editor.js     modeler bpmn-js, verrou, enregistrement, panneau redimensionnable
  assistant.js  conversation + revue une par une ; aiops.js applique les opérations
  properties.js, help.js (+ catalog.js), simulation.js, history.js
```

## Limites connues

- **Pas de branches dans l'interface.** Tout est commité sur une seule branche, mais le dépôt reste un dépôt Git standard : vous pouvez y travailler en branches à côté et fusionner sur la branche configurée. La synchronisation récupère alors les fichiers.
- **Conflits avec des commits extérieurs** : si une modification faite directement dans le dépôt touche le même fichier qu'un enregistrement local pas encore poussé, la synchronisation s'arrête sans rien écraser et l'erreur s'affiche dans **Administration → Dépôt Git**.
- **La dictée** dépend du navigateur (Chrome, Edge, Safari, en HTTPS uniquement). Sous Chrome, l'audio est transcrit par un service de Google.
- **Une seule personne modifie un diagramme à la fois** : il n'y a pas de coédition en temps réel.

Le logo bpmn.io affiché dans le canevas est exigé par la licence de bpmn-js et doit rester visible.
