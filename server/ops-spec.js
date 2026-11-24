// Description des opérations de modification, donnée à Claude (outil apply_changes du connecteur MCP).
export const OPS_SPEC = `Each change is an object:
{ "title": "short title in French",
  "why": "why this change, in French (1-2 sentences)",
  "benefit": "what it brings, in French (1 sentence)",
  "focus": ["ids of the existing or new elements to zoom on"],
  "ops": [ ...operations, applied in order... ] }

Operations (use existing ids from the diagram; give new elements a readable unique "ref" such as "Timer_RelanceKyc", reusable by later operations of the same or later changes):
- {"op":"update","id":"<id>","name":"…","documentation":"…"}                       (only the fields to change)
- {"op":"append","ref":"<newId>","after":"<id>","type":"bpmn:UserTask","name":"…"}  (creates the element after <id>, linked by a sequence flow; optional "flowName", "condition")
- {"op":"insert","ref":"<newId>","flow":"<sequenceFlowId>","type":"…","name":"…"}   (splits an existing sequence flow and puts the element in the middle)
- {"op":"attach","ref":"<newId>","to":"<activityId>","event":"timer","interrupting":false,"name":"…"}  (boundary event on an activity or sub-process)
- {"op":"connect","ref":"<newFlowId>","from":"<id>","to":"<id>","name":"…","condition":"\${…}"}
- {"op":"replace","id":"<id>","type":"bpmn:ServiceTask"}                             (change element type, keeps connections; for events also "event")
- {"op":"delete","id":"<id>"}
- {"op":"move","id":"<id>","next_to":"<otherId>","side":"right|left|below|above","gap":50}   (or "x","y" = new centre, or "dx","dy"; connected flows follow; if the spot is taken the element slides to the nearest free spot unless "avoid_overlap":false)
- {"op":"set_timer","id":"<eventId>","kind":"timeDuration|timeDate|timeCycle","value":"P3D"}
- {"op":"set_interrupting","id":"<boundaryOrEventSubprocessStartId>","value":false}
- {"op":"set_condition","id":"<sequenceFlowId>","expression":"\${montant > 1000}"}
- {"op":"set_default","gateway":"<gatewayId>","flow":"<sequenceFlowId>"}
- {"op":"set_error","id":"<eventId>","name":"Dossier expiré","code":"DOSSIER_EXPIRE"}   (also set_message / set_signal / set_escalation with "name")

Element types: bpmn:Task, bpmn:UserTask, bpmn:ServiceTask, bpmn:ScriptTask, bpmn:SendTask, bpmn:ReceiveTask, bpmn:ManualTask, bpmn:BusinessRuleTask, bpmn:CallActivity, bpmn:SubProcess, bpmn:StartEvent, bpmn:EndEvent, bpmn:IntermediateCatchEvent, bpmn:IntermediateThrowEvent, bpmn:ExclusiveGateway, bpmn:ParallelGateway, bpmn:InclusiveGateway, bpmn:EventBasedGateway, bpmn:TextAnnotation.
"event" (for events, attach and replace): none | timer | message | error | signal | escalation | compensate | conditional | terminate. With "event":"timer" you may add "timer":{"kind":"timeDuration","value":"P3D"}.
Timers use ISO 8601: P3D, PT48H, R3/P1D (3 times, every day), or an expression like \${dueDate} with kind timeDate.`;
