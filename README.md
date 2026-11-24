# Éditeur BPMN

Éditeur BPMN 2.0 collaboratif et auto-hébergé, en français. Il est construit sur [bpmn-js](https://bpmn.io), une bibliothèque open source sous licence MIT. Les diagrammes sont versionnés dans un dépôt **Git**.

- **Comptes** : n'importe qui peut créer un compte, mais il faut qu'un administrateur le valide. Un compte validé accède à tous les diagrammes. Pour partager un diagramme, il suffit d'envoyer l'adresse de sa page.
- **Brouillon et versions** : chaque modification est sauvegardée en continu sur le serveur (rien n'est perdu si l'onglet se ferme) et s'affiche en direct chez les autres personnes qui ont ouvert le diagramme. ↶ / ↷ annulent et rétablissent côté serveur, y compris les modifications faites par Claude. **« Enregistrer une version »** crée un commit Git avec un message, la personne connectée comme auteur, toujours sur la même branche. L'historique permet de consulter une version et de la remettre dans le brouillon.
- **Git** : un fichier `.bpmn` par diagramme. On peut ajouter un dépôt distant (GitHub, GitLab…) : il est cloné au démarrage, récupéré régulièrement, et chaque version y est poussée.
- **Édition** : une seule personne modifie un diagramme à la fois, grâce à un verrou. Les autres voient qui modifie et suivent ses changements en direct.
- **Connecteur Claude (MCP)** : ajouté comme connecteur dans Claude, l'éditeur permet de travailler un diagramme en discutant avec Claude, par écrit ou en conversation vocale. Claude lit le diagramme, le modifie (les changements apparaissent et sont surlignés à l'écran dans l'instant, annulables), zoome sur ce dont il parle, regarde le rendu, explore les parcours avec vous et enregistre une version quand vous le lui demandez.
- **Propriétés** en français : délais (ISO 8601 traduit en clair), événements interrompants ou non, erreurs, messages, conditions sur les flux sortants des passerelles, documentation. Chaque élément affiche une aide contextuelle, et un contrôle de cohérence passe sur tout le diagramme.
- **Assistant IA conversationnel**, par écrit ou en **conversation vocale** : l'IA *montre* ce dont elle parle. Elle zoome et surligne les éléments du diagramme au moment où elle les évoque, et peut faire une visite guidée zone par zone. Elle connaît la sélection et ce qui est visible à l'écran (« ici », « cette partie »). Elle propose ensuite des **modifications une par une** : pour chacune, l'éditeur zoome sur la zone concernée et explique pourquoi et ce que ça apporte. On accepte ou on refuse, à la souris ou de vive voix (« accepter », « refuser », « arrêter », « répète »). En conversation vocale, aucun bouton n'est nécessaire pour prendre la parole : le micro reste ouvert pendant que l'IA parle, et elle s'arrête dès que vous parlez. Sa propre voix captée par le micro est reconnue et ignorée, et la réponse en cours est coupée là où vous l'avez interrompue.
- **Centre d'aide** : recherche par intention (« relancer », « si / sinon »…), avec une vignette, une explication et l'insertion directe dans le diagramme.
- **Explorateur de parcours** : à chaque situation, il liste **toutes les suites que le diagramme autorise**. Ce sont les branches d'une passerelle (avec leurs conditions), la fin normale d'une tâche, chaque événement de bordure qui peut survenir (interrompant ou en parallèle), la course entre une réponse et un délai, et les sous-processus événementiels déclenchables « à tout moment ». On choisit une suite au clic ou au clavier (1-9), on revient en arrière pour essayer les autres, et le chemin parcouru reste surligné. Les branches qui s'arrêtent sans fin, les erreurs non capturées et les compensations exécutées sont signalées. « Ce n'est pas ce que j'attendais » ouvre l'assistant avec le parcours et les suites possibles, pour discuter de l'écart et corriger.
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
| `PUBLIC_URL` | Adresse publique, par exemple `https://bpmn.exemple.fr`. Recommandée derrière un proxy : elle sert aux adresses OAuth du connecteur Claude. Sinon, l'adresse est déduite de la requête (avec `TRUST_PROXY=true`). |

Le healthcheck répond sur `GET /healthz`.

**Mise à jour depuis la version précédente** : au premier démarrage, les diagrammes et les versions stockés dans l'ancienne base SQLite sont repris dans Git, avec leurs auteurs et leurs dates d'origine. Les liens de partage disparaissent : chaque personne crée maintenant son compte. Sans `ADMIN_EMAIL`, l'administrateur se connecte avec l'identifiant `admin` et le même `ADMIN_PASSWORD`.

## Connecter Claude

1. Le site doit être en **HTTPS** et joignable depuis Internet : Claude contacte le connecteur depuis ses propres serveurs.
2. Dans Claude : **Paramètres → Connecteurs → Ajouter un connecteur personnalisé**, adresse `https://<votre-domaine>/mcp` (elle est affichée et copiable dans « Mon compte »). Aucun identifiant client à saisir : Claude s'enregistre lui-même.
3. Claude ouvre une page de l'éditeur : connectez-vous si besoin, puis **Autoriser**. Claude agit ensuite **en votre nom** (vos versions sont signées de votre nom, les étapes du brouillon portent « via Claude »). L'accès se révoque dans « Mon compte ».
4. Ouvrez le diagramme dans votre navigateur et parlez-en à Claude, par exemple : « Ouvre le diagramme Onboarding et ajoute une relance tous les deux jours avant la signature. »

Outils exposés : `list_diagrams`, `get_diagram` (résumé lisible avec identifiants, délais, conditions et problèmes de cohérence, ou XML), `view_diagram` (image PNG de l'écran ou du diagramme entier), `apply_changes` (mêmes opérations que l'assistant intégré), `undo`, `redo`, `show` (zoom et surlignage), `explore` (parcours pas à pas, affiché à l'écran), `save_version`, `history`, `restore_version`, `create_diagram`.

Modifier, afficher et produire une image passent par la page ouverte dans votre navigateur : si le diagramme n'est ouvert nulle part, Claude le signale et donne le lien. Si vous ne modifiez pas déjà le diagramme, la page prend la main automatiquement à la première modification de Claude. Claude demande votre accord avant chaque outil qui modifie quelque chose, sauf si vous l'autorisez une fois pour toutes dans ses réglages.

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
  app.js        routes : comptes, diagrammes, brouillon, versions, verrou, assistant (flux SSE), WebSocket, /mcp
  mcp.js        serveur MCP (Streamable HTTP sans état) : outils du connecteur Claude
  oauth.js      OAuth 2.1 pour le connecteur : découverte, enregistrement dynamique, consentement, PKCE, rotation
  realtime.js   WebSocket : diffusion des brouillons, demandes du serveur à la page ouverte (appliquer, rendu)
  auth.js       comptes (scrypt), sessions signées, administrateur défini par l'environnement
  git.js        dépôt Git : écriture + commit par auteur, mv/rm, log --follow, clone/pull --rebase/push
  diagrams.js   index SQLite ↔ fichiers du dépôt, brouillon et ses étapes, versions, migration de l'ancien stockage
shared/         pathwalker.js (suites possibles), summary.js (résumé lisible), i18n.js : utilisés par le navigateur et le serveur
  ai.js         relais LLM en streaming (Anthropic / compatible OpenAI), prompt et format des opérations
web/src/
  editor.js     modeler bpmn-js, verrou, sauvegarde continue, versions, actions demandées par Claude ; live.js : WebSocket
  assistant.js  conversation + revue une par une ; aiops.js applique les opérations
  explorer.js   explorateur de parcours ; pathwalker.js calcule les suites possibles (testé sur le diagramme d'exemple)
  voice.js      conversation vocale (reconnaissance, envoi après une pause, lecture phrase par phrase, zoom synchronisé)
  properties.js, help.js (+ catalog.js), history.js
```

## Limites connues

- **Pas de branches dans l'interface.** Tout est commité sur une seule branche, mais le dépôt reste un dépôt Git standard : vous pouvez y travailler en branches à côté et fusionner sur la branche configurée. La synchronisation récupère alors les fichiers.
- **Conflits avec des commits extérieurs** : si une modification faite directement dans le dépôt touche le même fichier qu'un enregistrement local pas encore poussé, la synchronisation s'arrête sans rien écraser et l'erreur s'affiche dans **Administration → Dépôt Git**.
- **La voix** passe par le navigateur : reconnaissance vocale de Chrome, Edge ou Safari et voix de synthèse du système, **en HTTPS uniquement**. Sous Chrome, l'audio est transcrit par un service de Google. L'API d'Anthropic ne fournit pas de voix : seul le texte passe par le modèle. Pour une voix plus naturelle ou une transcription souveraine, on peut brancher un service de reconnaissance et de synthèse côté serveur.
- **L'explorateur** suit la sémantique BPMN courante : passerelles, événements de bordure, sous-processus et sous-processus événementiels, erreurs, terminaison, compensation. Il n'évalue pas les conditions, c'est vous qui choisissez la branche. Les pools et les flux de messages entre participants ne sont pas simulés.
- **Une seule personne modifie un diagramme à la fois** : les autres suivent en direct, mais il n'y a pas de coédition simultanée. Claude agit au nom de la personne qui l'a connecté, sur sa propre page.
- **Mise en page des ajouts de Claude** : elle est calculée par l'éditeur (comme pour l'assistant intégré) et un lien peut parfois traverser un autre élément. Claude peut s'en rendre compte avec `view_diagram` et déplacer, ou vous pouvez ajuster à la souris.
- **Le connecteur exige HTTPS** et un serveur joignable depuis Internet (Claude l'appelle depuis ses serveurs).

Le logo bpmn.io affiché dans le canevas est exigé par la licence de bpmn-js et doit rester visible.
