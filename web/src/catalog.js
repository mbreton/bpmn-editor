// Contenu du centre d'aide : chaque entrée décrit un composant ou un motif BPMN, avec une vignette
// (générée par buildSnippet) et, quand c'est possible, de quoi l'insérer dans le diagramme.

const SIZE = { start: 36, end: 36, catch: 36, throw: 36, xor: 50, and: 50, or: 50, evgw: 50 };
/** Enchaîne des éléments de gauche à droite, centrés sur la même ligne. */
function line(items, { y = 80, gap = 50, x0 = 20 } = {}) {
  let x = x0;
  const nodes = items.map((it, i) => {
    const w = it.w || SIZE[it.t] || 100;
    const hh = it.h || SIZE[it.t] || 80;
    const n = { id: it.id || `N${i}`, ...it, x, y: y - hh / 2 };
    x += w + gap;
    return n;
  });
  const flows = nodes.slice(1).map((n, i) => [nodes[i].id, n.id]);
  return { nodes, flows };
}
const solo = (t, extra = {}) => ({ nodes: [{ id: 'A', t, x: 20, y: 20, ...extra }], flows: [] });

const CATS = {
  start: 'Événements de début',
  inter: 'Attendre ou émettre',
  boundary: 'Événements de bordure',
  end: 'Événements de fin',
  task: 'Tâches',
  gw: 'Passerelles',
  sub: 'Sous-processus',
  data: 'Données et annotations',
  pattern: 'Motifs courants'
};
export { CATS };

export const CATALOG = [
  // ---------- début ----------
  { id: 'start', cat: 'start', title: 'Début', keys: 'commencer démarrer départ point d\'entrée',
    what: 'Point de départ du processus.', when: 'Chaque processus (et chaque sous-processus) a au moins un début.',
    spec: line([{ t: 'start', name: 'Demande reçue' }, { t: 'task', name: 'Traiter' }]),
    insert: { type: 'bpmn:StartEvent' } },
  { id: 'start-message', cat: 'start', title: 'Début sur réception d\'un message', keys: 'message email api webhook déclenché par',
    what: 'Le processus démarre quand un message précis arrive (formulaire, appel d\'API, e-mail…).', when: 'Quand le déclencheur vient de l\'extérieur et doit être identifié.',
    spec: line([{ t: 'start', ev: 'message', name: 'Souscription reçue' }, { t: 'task', name: 'Vérifier' }]),
    insert: { type: 'bpmn:StartEvent', eventDefinitionType: 'bpmn:MessageEventDefinition' } },
  { id: 'start-timer', cat: 'start', title: 'Début planifié (timer)', keys: 'planifié tous les jours chaque mois cron batch récurrent date',
    what: 'Le processus démarre à une date ou de façon périodique.', when: 'Traitements récurrents : clôture mensuelle, relevé quotidien, campagne annuelle.',
    spec: line([{ t: 'start', ev: 'timer', timer: ['timeCycle', 'R/P1M'], name: 'Chaque mois' }, { t: 'task', name: 'Clôturer' }]),
    insert: { type: 'bpmn:StartEvent', eventDefinitionType: 'bpmn:TimerEventDefinition' } },
  { id: 'start-signal', cat: 'start', title: 'Début sur signal', keys: 'signal diffusion broadcast plusieurs processus',
    what: 'Démarre quand un signal est diffusé ; tous les processus à l\'écoute démarrent.', when: 'Un même événement doit lancer plusieurs processus (ex. changement de réglementation).',
    spec: line([{ t: 'start', ev: 'signal', name: 'Taux modifié' }, { t: 'task', name: 'Recalculer' }]),
    insert: { type: 'bpmn:StartEvent', eventDefinitionType: 'bpmn:SignalEventDefinition' } },

  // ---------- intermédiaires ----------
  { id: 'catch-timer', cat: 'inter', title: 'Attendre un délai', keys: 'timer attendre délai pause jours heures temporisation j+3 date',
    what: 'Le jeton s\'arrête jusqu\'à l\'échéance, puis continue.', when: 'Délai de réflexion, attente avant relance, attente jusqu\'à une date calculée (timeDate ${dueDate}).',
    spec: line([{ t: 'task', name: 'Envoyer l\'offre' }, { t: 'catch', ev: 'timer', timer: ['timeDuration', 'P14D'], name: '14 jours' }, { t: 'task', name: 'Relancer' }]),
    insert: { type: 'bpmn:IntermediateCatchEvent', eventDefinitionType: 'bpmn:TimerEventDefinition' } },
  { id: 'catch-message', cat: 'inter', title: 'Attendre un message', keys: 'attendre réponse retour callback message recevoir',
    what: 'Le jeton attend la réception d\'un message précis.', when: 'Attente d\'une réponse client, d\'un retour de partenaire, d\'un callback d\'API.',
    spec: line([{ t: 'send', name: 'Demander les pièces' }, { t: 'catch', ev: 'message', name: 'Pièces reçues' }, { t: 'task', name: 'Contrôler' }]),
    insert: { type: 'bpmn:IntermediateCatchEvent', eventDefinitionType: 'bpmn:MessageEventDefinition' } },
  { id: 'throw-message', cat: 'inter', title: 'Envoyer un message', keys: 'envoyer notifier message émettre',
    what: 'Émet un message puis continue immédiatement.', when: 'Notification simple sans travail associé (sinon, préférez une tâche d\'envoi).',
    spec: line([{ t: 'task', name: 'Valider' }, { t: 'throw', ev: 'message', name: 'Client notifié' }, { t: 'end' }]),
    insert: { type: 'bpmn:IntermediateThrowEvent', eventDefinitionType: 'bpmn:MessageEventDefinition' } },
  { id: 'catch-conditional', cat: 'inter', title: 'Attendre une condition', keys: 'condition devient vraie seuil attendre que',
    what: 'Le jeton attend qu\'une condition sur les données devienne vraie.', when: 'Attendre qu\'un solde, un statut ou un seuil soit atteint.',
    spec: line([{ t: 'task', name: 'Ouvrir le compte' }, { t: 'catch', ev: 'conditional', name: 'Solde ≥ 100 €' }, { t: 'task', name: 'Activer' }]),
    insert: { type: 'bpmn:IntermediateCatchEvent', eventDefinitionType: 'bpmn:ConditionalEventDefinition' } },
  { id: 'throw-escalation', cat: 'inter', title: 'Escalader', keys: 'escalade remonter manager prévenir parent',
    what: 'Signale une situation au processus parent sans interrompre le travail en cours.', when: 'Dans un sous-processus : prévenir un responsable tout en continuant.',
    spec: line([{ t: 'task', name: 'Analyser' }, { t: 'throw', ev: 'escalation', name: 'Montant élevé' }, { t: 'task', name: 'Poursuivre' }]),
    insert: { type: 'bpmn:IntermediateThrowEvent', eventDefinitionType: 'bpmn:EscalationEventDefinition' } },
  { id: 'throw-compensate', cat: 'inter', title: 'Déclencher la compensation', keys: 'compenser annuler défaire rollback rembourser',
    what: 'Lance les activités de compensation des étapes déjà terminées (annuler une réservation, rembourser…).', when: 'Après un échec ou une expiration, pour revenir à un état métier cohérent.',
    spec: line([{ t: 'catch', ev: 'timer', timer: ['timeDate', '${dueDate}'], name: 'Échéance' }, { t: 'throw', ev: 'compensate', name: 'Compenser' }, { t: 'end', ev: 'error', name: 'Expiré' }]),
    insert: { type: 'bpmn:IntermediateThrowEvent', eventDefinitionType: 'bpmn:CompensateEventDefinition' } },

  // ---------- bordure ----------
  { id: 'b-timer-int', cat: 'boundary', title: 'Délai d\'expiration (interrompant)', keys: 'timeout expiration délai max sla annuler bordure interrompant échéance',
    what: 'Posé sur le bord d\'une activité : à l\'échéance, l\'activité est annulée et le jeton suit le flux du timer.', when: 'Délai maximum, SLA, expiration d\'une offre.',
    how: 'Déposez-le sur le bord de l\'activité concernée.',
    spec: { nodes: [{ id: 'T', t: 'user', x: 20, y: 20, name: 'Signer le contrat' }, { id: 'B', t: 'boundary', ev: 'timer', timer: ['timeDuration', 'P10D'], on: 'T', x: 52, y: 82, name: '10 jours' }, { id: 'X', t: 'task', x: 160, y: 130, name: 'Annuler le dossier' }], flows: [['B', 'X']] },
    insert: { type: 'bpmn:IntermediateCatchEvent', eventDefinitionType: 'bpmn:TimerEventDefinition', boundary: true } },
  { id: 'b-timer-nonint', cat: 'boundary', title: 'Relance (non interrompante)', keys: 'relance rappel notifier sans arrêter parallèle non interrompant bordure cycle',
    what: 'À l\'échéance, un flux parallèle démarre (relance, alerte) et l\'activité continue. Le cercle est en pointillés.', when: 'Relances périodiques (timeCycle R3/P1D), alerte à un manager.',
    how: 'Déposez-le sur le bord de l\'activité ; il est réglé en non interrompant automatiquement.',
    spec: { nodes: [{ id: 'T', t: 'user', x: 20, y: 20, name: 'Collecter les pièces' }, { id: 'B', t: 'boundary', ev: 'timer', timer: ['timeCycle', 'R3/P1D'], on: 'T', nonInt: true, x: 52, y: 82, name: 'Chaque jour (×3)' }, { id: 'X', t: 'send', x: 160, y: 130, name: 'Relancer' }], flows: [['B', 'X']] },
    insert: { type: 'bpmn:IntermediateCatchEvent', eventDefinitionType: 'bpmn:TimerEventDefinition', boundary: true, nonInterrupting: true } },
  { id: 'b-error', cat: 'boundary', title: 'Capturer une erreur', keys: 'erreur échec exception rejet attraper catch bordure',
    what: 'Intercepte une erreur métier levée par l\'activité (ou par une fin d\'erreur dans un sous-processus) et oriente vers un traitement.', when: 'Paiement refusé, KYC rejeté, dossier expiré.',
    how: 'Déposez-le sur le bord de l\'activité, puis choisissez l\'erreur dans le panneau Propriétés.',
    spec: { nodes: [{ id: 'T', t: 'service', x: 20, y: 20, name: 'Débiter' }, { id: 'B', t: 'boundary', ev: 'error', on: 'T', x: 52, y: 82, name: 'Refusé' }, { id: 'X', t: 'task', x: 160, y: 130, name: 'Informer le client' }], flows: [['B', 'X']] },
    insert: { type: 'bpmn:IntermediateCatchEvent', eventDefinitionType: 'bpmn:ErrorEventDefinition', boundary: true } },
  { id: 'b-message', cat: 'boundary', title: 'Message reçu pendant une activité', keys: 'annulation client message pendant interrompre bordure',
    what: 'Réagit à un message reçu pendant que l\'activité est en cours (interrompant ou non).', when: 'Le client annule sa demande pendant l\'instruction.',
    spec: { nodes: [{ id: 'T', t: 'user', x: 20, y: 20, name: 'Instruire' }, { id: 'B', t: 'boundary', ev: 'message', on: 'T', x: 52, y: 82, name: 'Annulation reçue' }, { id: 'X', t: 'task', x: 160, y: 130, name: 'Clôturer' }], flows: [['B', 'X']] },
    insert: { type: 'bpmn:IntermediateCatchEvent', eventDefinitionType: 'bpmn:MessageEventDefinition', boundary: true } },
  { id: 'b-compensate', cat: 'boundary', title: 'Compensation d\'une activité', keys: 'compensation annuler défaire handler rembourser',
    what: 'Relie une activité à l\'activité qui la défait. Elle ne s\'exécute que si une compensation est déclenchée.', when: 'Réservation à annuler, paiement à rembourser.',
    how: 'Déposez-le sur le bord de l\'activité, puis utilisez « Ajouter une activité de compensation » dans sa barre d\'outils.',
    spec: { nodes: [{ id: 'T', t: 'service', x: 20, y: 20, name: 'Réserver' }, { id: 'B', t: 'boundary', ev: 'compensate', on: 'T', x: 52, y: 82 }, { id: 'X', t: 'service', comp: true, x: 160, y: 120, name: 'Annuler la réservation' }], flows: [] },
    insert: { type: 'bpmn:IntermediateCatchEvent', eventDefinitionType: 'bpmn:CompensateEventDefinition', boundary: true } },

  // ---------- fin ----------
  { id: 'end', cat: 'end', title: 'Fin', keys: 'terminer fin arrêter',
    what: 'Termine le chemin suivi par ce jeton.', when: 'Chaque chemin doit se terminer par une fin explicite.',
    spec: line([{ t: 'task', name: 'Archiver' }, { t: 'end', name: 'Dossier clos' }]),
    insert: { type: 'bpmn:EndEvent' } },
  { id: 'end-error', cat: 'end', title: 'Fin en erreur', keys: 'erreur lever échec fin',
    what: 'Termine en levant une erreur, capturée par un événement d\'erreur sur le bord du sous-processus parent.', when: 'Signaler un échec métier au niveau supérieur.',
    spec: line([{ t: 'task', name: 'Contrôler' }, { t: 'end', ev: 'error', name: 'Rejeté' }]),
    insert: { type: 'bpmn:EndEvent', eventDefinitionType: 'bpmn:ErrorEventDefinition' } },
  { id: 'end-terminate', cat: 'end', title: 'Fin immédiate (terminaison)', keys: 'tout arrêter terminer immédiatement kill',
    what: 'Arrête immédiatement tous les chemins encore actifs du processus.', when: 'Un chemin rend les autres inutiles (ex. refus définitif).',
    spec: line([{ t: 'task', name: 'Refuser' }, { t: 'end', ev: 'terminate', name: 'Arrêt' }]),
    insert: { type: 'bpmn:EndEvent', eventDefinitionType: 'bpmn:TerminateEventDefinition' } },
  { id: 'end-message', cat: 'end', title: 'Fin avec envoi de message', keys: 'fin notifier message envoyer',
    what: 'Termine en envoyant un message.', when: 'Notifier le résultat au client ou à un système à la fin.',
    spec: line([{ t: 'task', name: 'Décider' }, { t: 'end', ev: 'message', name: 'Décision envoyée' }]),
    insert: { type: 'bpmn:EndEvent', eventDefinitionType: 'bpmn:MessageEventDefinition' } },

  // ---------- tâches ----------
  { id: 'task', cat: 'task', title: 'Tâche', keys: 'activité étape action',
    what: 'Une unité de travail, sans précision sur qui ou quoi l\'exécute.', when: 'Modélisation de haut niveau.',
    spec: solo('task', { name: 'Traiter la demande' }), insert: { type: 'bpmn:Task' } },
  { id: 'user', cat: 'task', title: 'Tâche utilisateur', keys: 'humain personne valider saisir formulaire',
    what: 'Travail fait par une personne, souvent via un écran.', when: 'Validation, saisie, revue.',
    spec: solo('user', { name: 'Valider le dossier' }), insert: { type: 'bpmn:UserTask' } },
  { id: 'service', cat: 'task', title: 'Tâche de service', keys: 'api appel système automatique backend',
    what: 'Travail automatique fait par un système (appel d\'API, traitement).', when: 'Intégrations, calculs automatiques.',
    spec: solo('service', { name: 'Créer le contrat' }), insert: { type: 'bpmn:ServiceTask' } },
  { id: 'send', cat: 'task', title: 'Tâche d\'envoi', keys: 'envoyer email courrier notification',
    what: 'Envoie un message (e-mail, courrier, appel sortant).', when: 'Relances, notifications avec préparation.',
    spec: solo('send', { name: 'Envoyer le contrat' }), insert: { type: 'bpmn:SendTask' } },
  { id: 'receive', cat: 'task', title: 'Tâche de réception', keys: 'recevoir attendre réception',
    what: 'Attend la réception d\'un message.', when: 'Équivalent d\'une attente de message ; utilisable après une passerelle basée sur les événements.',
    spec: solo('receive', { name: 'Recevoir la signature' }), insert: { type: 'bpmn:ReceiveTask' } },
  { id: 'script', cat: 'task', title: 'Tâche script', keys: 'script calcul variable code',
    what: 'Exécute un script dans le moteur (calcul d\'une échéance, d\'une variable).', when: 'Calculer dueDate = now + 30j avant un timer en date absolue.',
    spec: solo('script', { name: 'Calculer l\'échéance' }), insert: { type: 'bpmn:ScriptTask' } },
  { id: 'rule', cat: 'task', title: 'Tâche règle métier', keys: 'règle dmn décision barème scoring',
    what: 'Applique une règle ou une table de décision (DMN).', when: 'Scoring, barème, éligibilité.',
    spec: solo('rule', { name: 'Évaluer le risque' }), insert: { type: 'bpmn:BusinessRuleTask' } },
  { id: 'manual', cat: 'task', title: 'Tâche manuelle', keys: 'manuel hors système papier physique',
    what: 'Travail fait sans aucun système (archivage papier, déplacement).', when: 'Étapes physiques.',
    spec: solo('manual', { name: 'Archiver l\'original' }), insert: { type: 'bpmn:ManualTask' } },
  { id: 'call', cat: 'task', title: 'Activité d\'appel', keys: 'appeler réutiliser sous-processus global',
    what: 'Appelle un autre processus défini ailleurs et réutilisable.', when: 'Processus partagé (ex. KYC) appelé depuis plusieurs parcours.',
    spec: solo('call', { name: 'Processus KYC' }), insert: { type: 'bpmn:CallActivity' } },

  // ---------- passerelles ----------
  { id: 'xor', cat: 'gw', title: 'Choix exclusif (OU exclusif)', keys: 'si sinon condition choix décision alternative xor',
    what: 'Un seul chemin est suivi, selon des conditions sur les flux sortants.', when: 'Montant > seuil ? Dossier complet ?',
    how: 'Mettez une condition sur chaque flux sortant, ou marquez-en un comme flux par défaut.',
    spec: { nodes: [{ id: 'G', t: 'xor', x: 20, y: 55, name: 'Complet ?' }, { id: 'A', t: 'task', x: 130, y: 0, name: 'Valider' }, { id: 'B', t: 'task', x: 130, y: 100, name: 'Compléter' }], flows: [['G', 'A', 'oui'], ['G', 'B', 'non']] },
    insert: { type: 'bpmn:ExclusiveGateway' } },
  { id: 'and', cat: 'gw', title: 'En parallèle (ET)', keys: 'parallèle en même temps simultané et fork join synchroniser',
    what: 'Ouvre plusieurs chemins en parallèle ; une deuxième passerelle parallèle attend qu\'ils soient tous terminés.', when: 'Contrôles indépendants à mener en même temps.',
    spec: { nodes: [{ id: 'G', t: 'and', x: 20, y: 55 }, { id: 'A', t: 'task', x: 110, y: 0, name: 'Vérifier l\'identité' }, { id: 'B', t: 'task', x: 110, y: 100, name: 'Vérifier les revenus' }, { id: 'J', t: 'and', x: 260, y: 55 }], flows: [['G', 'A'], ['G', 'B'], ['A', 'J'], ['B', 'J']] },
    insert: { type: 'bpmn:ParallelGateway' } },
  { id: 'or', cat: 'gw', title: 'Choix multiple (OU inclusif)', keys: 'un ou plusieurs inclusif options',
    what: 'Un ou plusieurs chemins selon les conditions vraies.', when: 'Options cumulables (ex. assurances complémentaires choisies).',
    spec: { nodes: [{ id: 'G', t: 'or', x: 20, y: 55 }, { id: 'A', t: 'task', x: 130, y: 0, name: 'Option A' }, { id: 'B', t: 'task', x: 130, y: 100, name: 'Option B' }], flows: [['G', 'A'], ['G', 'B']] },
    insert: { type: 'bpmn:InclusiveGateway' } },
  { id: 'evgw', cat: 'gw', title: 'Le premier événement qui arrive', keys: 'course premier attente message ou délai event based gateway',
    what: 'Attend plusieurs événements ; le premier qui survient décide du chemin, les autres sont abandonnés.', when: 'Réponse du client OU 15 jours sans réponse.',
    spec: { nodes: [{ id: 'G', t: 'evgw', x: 20, y: 55 }, { id: 'A', t: 'catch', ev: 'message', x: 120, y: 12, name: 'Réponse' }, { id: 'B', t: 'catch', ev: 'timer', timer: ['timeDuration', 'P15D'], x: 120, y: 112, name: '15 jours' }], flows: [['G', 'A'], ['G', 'B']] },
    insert: { type: 'bpmn:EventBasedGateway' } },

  // ---------- sous-processus ----------
  { id: 'sub', cat: 'sub', title: 'Sous-processus', keys: 'regrouper bloc périmètre délai global plusieurs étapes',
    what: 'Regroupe plusieurs étapes. Un timer posé sur son bord couvre toutes les étapes à l\'intérieur.', when: 'Délai global sur une phase, gestion d\'erreur commune.',
    spec: { nodes: [{ id: 'S', t: 'sub', x: 10, y: 10, w: 330, h: 130, name: 'Constitution du dossier' }, { id: 's1', t: 'start', parent: 'S', x: 30, y: 57 }, { id: 'a', t: 'task', parent: 'S', x: 100, y: 35, name: 'Collecter' }, { id: 'e', t: 'end', parent: 'S', x: 260, y: 57 }], flows: [['s1', 'a'], ['a', 'e']] },
    insert: { type: 'bpmn:SubProcess', isExpanded: true } },
  { id: 'evsub', cat: 'sub', title: 'Sous-processus événementiel', keys: 'événementiel event subprocess pendant tout le périmètre échéance réaction',
    what: 'Placé dans un sous-processus, il se déclenche sur un événement (timer, message, erreur) à tout moment pendant que le parent est actif.', when: 'Échéance contractuelle avec compensation, annulation à tout moment.',
    spec: { nodes: [{ id: 'S', t: 'sub', triggered: true, x: 10, y: 10, w: 300, h: 110, name: 'Échéance' }, { id: 's1', t: 'start', ev: 'timer', timer: ['timeDate', '${dueDate}'], parent: 'S', x: 40, y: 47 }, { id: 'a', t: 'throw', ev: 'compensate', parent: 'S', x: 130, y: 47 }, { id: 'e', t: 'end', ev: 'error', parent: 'S', x: 230, y: 47 }], flows: [['s1', 'a'], ['a', 'e']] },
    insert: { type: 'bpmn:SubProcess', isExpanded: true, triggeredByEvent: true } },

  // ---------- données ----------
  { id: 'note', cat: 'data', title: 'Annotation', keys: 'commentaire note texte remarque',
    what: 'Commentaire libre relié à un élément.', when: 'Expliquer une règle, un point d\'attention.',
    spec: solo('note', { name: 'Délai contractuel : 30 jours' }), insert: { type: 'bpmn:TextAnnotation' } },
  { id: 'data', cat: 'data', title: 'Objet de données', keys: 'document données pièce fichier',
    what: 'Une donnée ou un document lu ou produit par une activité.', when: 'Contrat, pièce justificative, dossier.',
    spec: solo('data', { name: 'Contrat signé' }), insert: { type: 'bpmn:DataObjectReference' } },
  { id: 'store', cat: 'data', title: 'Stockage de données', keys: 'base de données stockage crm système',
    what: 'Un stockage persistant (base de données, CRM).', when: 'Montrer où l\'information est enregistrée.',
    spec: solo('store', { name: 'CRM' }), insert: { type: 'bpmn:DataStoreReference' } },
  { id: 'pool', cat: 'data', title: 'Pool (participant)', keys: 'pool participant acteur organisation couloir lane',
    what: 'Représente un participant (votre organisation, l\'assureur, le client). Les échanges entre pools passent par des flux de message.', when: 'Montrer qui fait quoi entre organisations.',
    spec: solo('task', { name: 'Voir l\'éditeur' }), insert: { type: 'bpmn:Participant' } },

  // ---------- motifs ----------
  { id: 'p-sla', cat: 'pattern', title: 'Relance puis expiration (SLA)', keys: 'sla relance expiration délai rappel annulation combinaison',
    what: 'Une relance non interrompante (ex. J+3) et une expiration interrompante (ex. J+10) sur la même activité.', when: 'Attente d\'une action client avec rappels puis abandon.',
    spec: { nodes: [{ id: 'T', t: 'user', x: 20, y: 20, name: 'Attendre les pièces' }, { id: 'R', t: 'boundary', ev: 'timer', timer: ['timeDuration', 'P3D'], nonInt: true, on: 'T', x: 34, y: 82, name: 'J+3' }, { id: 'E', t: 'boundary', ev: 'timer', timer: ['timeDuration', 'P10D'], on: 'T', x: 82, y: 82, name: 'J+10' }, { id: 'X', t: 'send', x: 150, y: 140, name: 'Relancer' }, { id: 'Y', t: 'task', x: 280, y: 140, name: 'Rejeter' }], flows: [['R', 'X'], ['E', 'Y']] },
    ask: 'Sur la tâche sélectionnée, ajoute une relance non interrompante à J+3 qui envoie un rappel au client, et une expiration interrompante à J+10 qui rejette le dossier puis termine le processus.' },
  { id: 'p-race', cat: 'pattern', title: 'Réponse attendue ou délai dépassé', keys: 'course réponse ou délai attente premier arrivé',
    what: 'Une passerelle basée sur les événements suivie d\'une attente de message et d\'un timer.', when: 'Attendre un versement, une signature, une réponse, avec un délai maximum.',
    spec: { nodes: [{ id: 'G', t: 'evgw', x: 20, y: 55 }, { id: 'A', t: 'catch', ev: 'message', x: 120, y: 12, name: 'Versement reçu' }, { id: 'B', t: 'catch', ev: 'timer', timer: ['timeDuration', 'P15D'], x: 120, y: 112, name: '15 jours' }, { id: 'C', t: 'task', x: 210, y: -10, name: 'Activer' }, { id: 'D', t: 'task', x: 210, y: 90, name: 'Clôturer' }], flows: [['G', 'A'], ['G', 'B'], ['A', 'C'], ['B', 'D']] },
    ask: 'Après l\'élément sélectionné, attends soit un message « Réponse reçue » soit 15 jours (passerelle basée sur les événements) ; si la réponse arrive, continue le traitement ; sinon clôture le dossier.' },
  { id: 'p-due', cat: 'pattern', title: 'Délai qui démarre à une étape antérieure', keys: 'dueDate date calculée échéance depuis étape x date absolue',
    what: 'On calcule une date d\'échéance à l\'étape de départ (tâche script), puis un timer en date absolue (timeDate = ${dueDate}) la contrôle plus loin.', when: 'Délai contractuel ou réglementaire qui court depuis un événement précis.',
    spec: line([{ t: 'user', name: 'Valider (étape X)' }, { t: 'script', name: 'dueDate = +30 j' }, { t: 'task', name: '…' }, { t: 'catch', ev: 'timer', timer: ['timeDate', '${dueDate}'], name: 'Échéance' }], { gap: 30 }),
    ask: 'Juste après l\'élément sélectionné, ajoute une tâche script qui calcule dueDate = maintenant + 30 jours, puis utilise un timer en date absolue (timeDate ${dueDate}) pour faire expirer le dossier.' },
  { id: 'p-comp', cat: 'pattern', title: 'Annuler et compenser à l\'échéance', keys: 'compensation annulation échéance rollback défaire saga',
    what: 'Un sous-processus événementiel déclenché par un timer compense les étapes déjà faites, puis lève une erreur capturée par le parent.', when: 'Délai expiré après des réservations ou paiements déjà effectués.',
    spec: { nodes: [{ id: 'S', t: 'sub', triggered: true, x: 10, y: 10, w: 300, h: 110, name: 'Échéance' }, { id: 's1', t: 'start', ev: 'timer', timer: ['timeDate', '${dueDate}'], parent: 'S', x: 40, y: 47 }, { id: 'a', t: 'throw', ev: 'compensate', parent: 'S', x: 130, y: 47, name: 'Compenser' }, { id: 'e', t: 'end', ev: 'error', parent: 'S', x: 230, y: 47, name: 'Expiré' }], flows: [['s1', 'a'], ['a', 'e']] },
    ask: 'Dans le sous-processus sélectionné, ajoute un sous-processus événementiel interrompant déclenché à l\'échéance ${dueDate}, qui compense les étapes terminées puis lève l\'erreur « Dossier expiré » ; capture cette erreur sur le bord du sous-processus et notifie le client.' }
];
