# Éditeur BPMN

Éditeur BPMN 2.0 collaboratif et auto-hébergé, en français. Il est construit sur [bpmn-js](https://bpmn.io), une bibliothèque open source sous licence MIT.

- **Édition** du diagramme : palette, barre d'outils contextuelle, annuler et rétablir.
- **Panneau de propriétés** : noms, délais (durée, date, cycle ISO 8601, avec leur traduction en clair), événements interrompants ou non, erreurs, messages, signaux et escalades, conditions et flux par défaut, scripts, documentation.
- **Contrôle de cohérence** : éléments jamais atteints, chemins sans fin, passerelles sans condition, timers vides, etc.
- **Assistant IA** : on écrit ou on dicte une demande. La proposition s'affiche sur le diagramme, avec les ajouts en vert, les modifications en orange et la liste des suppressions. On l'accepte, on la précise ou on l'annule.
- **Centre d'aide** : recherche par intention (« relancer », « si / sinon », « en parallèle »…). Chaque composant a une vignette, une explication, et un bouton pour l'ajouter au diagramme ou le demander à l'assistant.
- **Simulation pas à pas** (bpmn-js-token-simulation) : les jetons avancent élément par élément avec le bouton « Étape suivante ». On choisit la branche aux passerelles et on déclenche les timers et messages à la main.
- **Collaboration** : verrou d'édition (une seule personne modifie à la fois, les autres voient qui), historique des versions avec restauration, détection des conflits.
- **Partage** : liens par diagramme, en lecture et simulation ou en modification, sans compte et révocables.
- **Export** : `.bpmn`, SVG, PNG.

## Démarrage en local

```bash
npm install
cp .env.example .env        # puis renseigner ADMIN_PASSWORD (et LLM_API_KEY pour l'assistant)
npm run build
node --env-file=.env server/index.js
# → http://localhost:3000
```

En développement, avec rechargement à chaud : `node --env-file=.env --watch server/index.js` dans un terminal et `npx vite` dans un autre, puis ouvrir http://localhost:5173.

Tests de l'API : `npm test`.

## Déploiement sur Coolify

1. **New resource → Public/Private repository** : pointer sur ce dépôt, branche `main`.
2. Build pack : **Dockerfile** (ou **Docker Compose** avec le `docker-compose.yml` fourni).
3. **Ports Exposes : `3000`**. C'est le port interne vers lequel le proxy de Coolify envoie le trafic, inutile de publier un port sur l'hôte. Associez un domaine (en Docker Compose : `https://votre-domaine:3000` dans le champ Domains du service, le `:3000` désignant le port interne). Coolify fournit le HTTPS.
4. **Stockage persistant** : monter un volume sur `/data`. La base SQLite s'y trouve, avec les diagrammes, les versions et les liens. C'est le seul élément à sauvegarder.
5. Variables d'environnement (voir `.env.example`) :

| Variable | Obligatoire | Rôle |
|---|---|---|
| `ADMIN_PASSWORD` | oui | Mot de passe de l'administrateur (création, suppression, liens de partage). |
| `SESSION_SECRET` | non | Secret de signature des sessions. Sans lui, un secret est généré et stocké en base. |
| `LLM_API_KEY` | pour l'IA | Clé du fournisseur. Sans clé, l'assistant est désactivé et le reste fonctionne. |
| `LLM_PROVIDER` | non | `anthropic` (par défaut) ou `openai` pour toute API compatible `/chat/completions` (OpenAI, LiteLLM, Scaleway, Mistral, vLLM…). |
| `LLM_MODEL` | non | Par défaut `claude-sonnet-5-5` avec Anthropic. |
| `LLM_BASE_URL` | non | URL de l'API, par ex. `https://api.scaleway.ai/v1` ou l'URL d'un proxy LiteLLM. |
| `AI_RATE_LIMIT_PER_HOUR` | non | Nombre d'appels IA par heure et par adresse IP (40 par défaut). |
| `COOKIE_SECURE` | non | `true` par défaut en production. Mettre `false` seulement si le site est servi en HTTP. |
| `LISTEN_HOST` | non | Interface d'écoute, `0.0.0.0` par défaut. |
| `TRUST_PROXY` | non | `true` par défaut, adapté derrière le proxy de Coolify. Mettre `false` si le conteneur est exposé directement. |

Le healthcheck répond sur `GET /healthz`.

## Utilisation

- **Administrateur** : se connecter avec `ADMIN_PASSWORD`, créer ou importer des diagrammes, puis créer des liens de partage depuis l'onglet **Partage** de chaque diagramme.
- **Personnes invitées** : elles ouvrent le lien `https://votre-domaine/s/<jeton>`. Avec un lien « Modification », le bouton **Modifier** prend le verrou. Il est renouvelé automatiquement et libéré avec « Terminer » ou à la fermeture de l'onglet (au plus tard 90 s après). Le nom saisi au premier passage s'affiche aux autres personnes et dans l'historique.
- **Assistant** : il faut être en mode édition. Les éléments sélectionnés sont transmis à l'IA comme contexte. **Préciser** renvoie la proposition en cours avec votre correction. **Annuler** rétablit exactement le diagramme d'avant. Après **Accepter**, il faut enregistrer, et un lien « Revenir à l'état d'avant » reste disponible.
- **Simulation** : bouton **Simuler**, puis ▶ à côté d'un événement de début.

## Architecture

```
server/        API Fastify + SQLite (module natif node:sqlite, aucune dépendance compilée)
  app.js       routes : diagrammes, versions, verrou, liens de partage, assistant IA
  db.js        schéma et requêtes (concurrence optimiste + bail de verrou de 90 s)
  ai.js        relais LLM, validation du BPMN renvoyé (bpmn-moddle + présence de la DI), une passe de correction automatique
web/src/       application Vite sans framework
  editor.js    modeler bpmn-js, verrou, enregistrement, export
  properties.js, assistant.js, help.js (+ catalog.js, snippet.js), simulation.js, history.js, sharing.js
```

## Limites connues

- La **dictée** utilise la reconnaissance vocale du navigateur (Chrome, Edge, Safari). Le bouton micro est masqué ailleurs, notamment sous Firefox. Sous Chrome, l'audio est transcrit par le service de reconnaissance de Google.
- Afficher une proposition de l'IA ou une ancienne version recharge le diagramme : la pile annuler/rétablir repart de zéro. L'historique des versions et le lien « Revenir à l'état d'avant » prennent le relais.
- Pas de coédition en temps réel : une seule personne modifie à la fois, c'est le rôle du verrou.
- Un seul compte administrateur. Les autres accès passent par les liens de partage.

Le logo bpmn.io affiché dans le canevas est exigé par la licence de bpmn-js et doit rester visible.
