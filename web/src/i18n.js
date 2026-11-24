// Traduction française de l'interface bpmn-js et de la simulation de jetons.
const FR = {
  // palette et outils
  'Activate hand tool': 'Main (déplacer la vue)',
  'Activate lasso tool': 'Lasso (sélection multiple)',
  'Activate create/remove space tool': 'Créer / retirer de l\'espace',
  'Activate global connect tool': 'Relier deux éléments',
  'Create start event': 'Événement de début',
  'Create intermediate/boundary event': 'Événement intermédiaire / de bordure',
  'Create end event': 'Événement de fin',
  'Create gateway': 'Passerelle',
  'Create task': 'Tâche',
  'Create expanded sub-process': 'Sous-processus',
  'Create data object reference': 'Objet de données',
  'Create data store reference': 'Stockage de données',
  'Create pool/participant': 'Pool / participant',
  'Create group': 'Groupe',
  // menu contextuel
  'Append end event': 'Ajouter un événement de fin',
  'Append gateway': 'Ajouter une passerelle',
  'Append task': 'Ajouter une tâche',
  'Append intermediate/boundary event': 'Ajouter un événement intermédiaire',
  'Append timer intermediate catch event': 'Ajouter un délai (timer)',
  'Append message intermediate catch event': 'Ajouter une attente de message',
  'Append signal intermediate catch event': 'Ajouter une attente de signal',
  'Append conditional intermediate catch event': 'Ajouter une attente de condition',
  'Append receive task': 'Ajouter une tâche de réception',
  'Append compensation activity': 'Ajouter une activité de compensation',
  'Add text annotation': 'Ajouter une annotation',
  'Add lane above': 'Ajouter un couloir au-dessus',
  'Add lane below': 'Ajouter un couloir en dessous',
  'Divide into two lanes': 'Diviser en deux couloirs',
  'Divide into three lanes': 'Diviser en trois couloirs',
  'Change element': 'Changer le type',
  'Change type': 'Changer le type',
  'Connect to other element': 'Relier à un autre élément',
  'Connect using association': 'Relier par une association',
  'Connect using data input association': 'Relier par une association de données',
  'Delete': 'Supprimer',
  'Search in diagram': 'Rechercher dans le diagramme',
  // simulation
  'Token Simulation': 'Simulation pas à pas',
  'Play/Pause Simulation': 'Lecture / pause',
  'Play Simulation': 'Lecture',
  'Pause Simulation': 'Pause',
  'Reset Simulation': 'Réinitialiser la simulation',
  'Simulation Log': 'Journal de simulation',
  'Toggle Simulation Log': 'Afficher le journal',
  'Set Sequence Flow': 'Choisir ce flux',
  'Trigger Event': 'Déclencher l\'événement',
  'Set animation speed = {speed}': 'Vitesse d\'animation : {speed}',
  'Focus process instance {scopeId}': 'Suivre l\'instance {scopeId}',
  'Found unsupported elements': 'Éléments non pris en charge par la simulation',
  'Not supported': 'Non pris en charge',
  'No Entries': 'Aucune entrée',
  'Finished': 'Terminé',
  'Close': 'Fermer',
  '{name} started': '{name} démarré',
  'Process started': 'Processus démarré',
  'Process finished': 'Processus terminé',
  'SubProcess started': 'Sous-processus démarré',
  'SubProcess finished': 'Sous-processus terminé',
  'Start Event': 'Événement de début',
  'End Event': 'Événement de fin',
  'Intermediate Event': 'Événement intermédiaire',
  'Boundary Event': 'Événement de bordure',
  'Task': 'Tâche',
  'User Task': 'Tâche utilisateur',
  'Service Task': 'Tâche de service',
  'Script Task': 'Tâche script',
  'Send Task': 'Tâche d\'envoi',
  'Receive Task': 'Tâche de réception',
  'Manual Task': 'Tâche manuelle',
  'Business Rule Task': 'Tâche règle métier',
  'Call Activity': 'Activité d\'appel',
  'Exclusive Gateway': 'Passerelle exclusive',
  'Parallel Gateway': 'Passerelle parallèle',
  'Inclusive Gateway': 'Passerelle inclusive'
};

export function translate(template, replacements = {}) {
  const t = FR[template] || template;
  return t.replace(/{([^}]+)}/g, (_, key) => replacements[key] ?? `{${key}}`);
}

export const TranslateModule = { translate: ['value', translate] };

export const TYPE_LABELS = {
  'bpmn:StartEvent': 'Événement de début',
  'bpmn:EndEvent': 'Événement de fin',
  'bpmn:IntermediateCatchEvent': 'Événement intermédiaire (attente)',
  'bpmn:IntermediateThrowEvent': 'Événement intermédiaire (émission)',
  'bpmn:BoundaryEvent': 'Événement de bordure',
  'bpmn:Task': 'Tâche',
  'bpmn:UserTask': 'Tâche utilisateur',
  'bpmn:ServiceTask': 'Tâche de service',
  'bpmn:ScriptTask': 'Tâche script',
  'bpmn:SendTask': 'Tâche d\'envoi',
  'bpmn:ReceiveTask': 'Tâche de réception',
  'bpmn:ManualTask': 'Tâche manuelle',
  'bpmn:BusinessRuleTask': 'Tâche règle métier',
  'bpmn:CallActivity': 'Activité d\'appel',
  'bpmn:SubProcess': 'Sous-processus',
  'bpmn:Transaction': 'Transaction',
  'bpmn:ExclusiveGateway': 'Passerelle exclusive',
  'bpmn:ParallelGateway': 'Passerelle parallèle',
  'bpmn:InclusiveGateway': 'Passerelle inclusive',
  'bpmn:EventBasedGateway': 'Passerelle basée sur les événements',
  'bpmn:ComplexGateway': 'Passerelle complexe',
  'bpmn:SequenceFlow': 'Flux de séquence',
  'bpmn:MessageFlow': 'Flux de message',
  'bpmn:Association': 'Association',
  'bpmn:TextAnnotation': 'Annotation',
  'bpmn:DataObjectReference': 'Objet de données',
  'bpmn:DataStoreReference': 'Stockage de données',
  'bpmn:Participant': 'Pool / participant',
  'bpmn:Lane': 'Couloir',
  'bpmn:Group': 'Groupe',
  'bpmn:Process': 'Processus',
  'bpmn:Collaboration': 'Collaboration'
};

export const DEF_LABELS = {
  'bpmn:TimerEventDefinition': 'Timer',
  'bpmn:MessageEventDefinition': 'Message',
  'bpmn:ErrorEventDefinition': 'Erreur',
  'bpmn:EscalationEventDefinition': 'Escalade',
  'bpmn:CompensateEventDefinition': 'Compensation',
  'bpmn:SignalEventDefinition': 'Signal',
  'bpmn:ConditionalEventDefinition': 'Condition',
  'bpmn:TerminateEventDefinition': 'Terminaison',
  'bpmn:LinkEventDefinition': 'Lien',
  'bpmn:CancelEventDefinition': 'Annulation'
};

/** "R3/P1D" → "3 fois, toutes les 1 jour" ; "PT48H" → "48 heures". Renvoie '' si non reconnu. */
export function explainIso(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (/^\$\{.+\}$/.test(v) || /^#\{.+\}$/.test(v)) return 'expression évaluée à l\'exécution';
  const cyc = /^R(\d*)(?:\/(\d{4}-[^/]+))?\/(P[^/]+)$/.exec(v);
  if (cyc) {
    const period = explainIso(cyc[3]);
    if (!period) return '';
    const n = cyc[1];
    const every = /^1 [a-z]+$/.test(period) ? `chaque ${period.slice(2)}`
      : `${/(jours?|mois|ans?)$/.test(period) ? 'tous' : 'toutes'} les ${period}`;
    return (n ? `${n} fois, ` : 'indéfiniment, ') + every + (cyc[2] ? ` à partir du ${cyc[2]}` : '');
  }
  const d = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(v);
  if (d && v !== 'P' && v !== 'PT') {
    const u = [['an', 'ans'], ['mois', 'mois'], ['semaine', 'semaines'], ['jour', 'jours'], ['heure', 'heures'], ['minute', 'minutes'], ['seconde', 'secondes']];
    return d.slice(1).map((n, i) => n ? `${n} ${u[i][n === '1' ? 0 : 1]}` : '').filter(Boolean).join(' ');
  }
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v)) {
    const t = new Date(v);
    if (!isNaN(t)) return 'le ' + t.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: v.includes('T') ? 'short' : undefined });
  }
  return '';
}
