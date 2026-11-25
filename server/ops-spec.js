// Description des opérations de modification, donnée à Claude (outil apply_changes du connecteur MCP).
export const OPS_SPEC = `NAMES MUST FIT THEIR SHAPE: a task box (100×80) holds 5 short lines, about 55 characters (4 lines, about 45 characters, if it carries a boundary event); event and gateway labels about 4 lines (≈ 60 characters). Write short names (verb + object) and put details, rules, thresholds and legal references in "documentation". A name that would overflow is rejected with the length to aim for.

Each change is an object:
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
- {"op":"delete","id":"<id>"}   (deleting an element that has exactly one incoming and one outgoing flow reconnects its neighbours automatically: do not add a "connect" for them)
- {"op":"reroute","id":"<sequenceFlowId>","route":"h:v|v:h|h:h|v:v"}   (redraw a flow: h:v = leave horizontally then turn vertically, v:h = leave vertically first…; or "via":[{"x":..,"y":..},…] bend points for a precise path, e.g. to loop back below the main line. "connect" also accepts "route" and "via"; without them, a flow going back to the left is automatically drawn below the elements it passes)
- {"op":"add","ref":"<newId>","in":"<expandedSubProcessOrParticipantId>","type":"bpmn:StartEvent","name":"…","x":…,"y":…}   (creates an unconnected element inside a container, e.g. the first element of an empty sub-process; x/y = centre, optional). To expand a collapsed sub-process first: {"op":"replace","id":"<id>","type":"bpmn:SubProcess","expanded":true}
- READABILITY (the user's drawing rules):
  · a flow must never be drawn on top of another flow or through an element; keep crossings to a minimum, then bends: the most direct line wins (straight when the two shapes face each other).
  · when a flow crosses another, do not only redraw YOUR flow: ask whether the OTHER flow or the OTHER branch should move instead (e.g. move the elements of the other branch above the main line with "move", so both lines become straight). Prefer moving a branch over a long detour.
  · never touch a flow that is already straight and conflict-free; after moving elements, straighten the flows that can now be straight (move and tidy do it).
  · keep vertical gaps tight (about 40 px between rows); do not leave a branch far below what is above it.
  · labels sit at a fixed small distance: a gateway name just above it (or below), an event name just below it, a flow name right next to its first segment, never on a line.
  · a comment (TextAnnotation) goes close to its element (about 25 px, above it by preference) in a free spot, wide rather than tall (3 lines aimed, up to 320 px); its dotted line must cross no box, no flow and no other dotted line; no trailing line breaks in its text. Dotted lines are not reported by the coherence check: place them well anyway.
  · a flow enters and leaves a gateway by one of its four tips, never through the middle of a side of the diamond.
  · a flow never runs along the border of a box (e.g. the flow of a boundary event drawn on the box's own edge): every line must be visible on its own.
  · when you move or remove a block in the middle of the path, shift everything after it with "space" (and close empty columns) instead of moving blocks one by one; tidy also closes vertical bands wider than 130 px and trims the empty space of the pool.
  · a task carrying a boundary event (clock…) holds 4 lines of text, not 5.
  connect/move/tidy apply these automatically; the coherence check reports what is left (flow crossings are listed as « à vérifier »).
- {"op":"space","after":"<id>","dx":120}   (shifts at once everything to the right of the element (or of "x") by dx px, negative dx closes a gap; the pool and crossed sub-processes grow or shrink with it; "dy" with "after" or "y" for vertical; refused if closing would create an overlap)
- {"op":"resize","id":"<annotationOrExpandedSubProcessOrPoolId>","width":260,"height":60}   (top-left corner stays; tasks, events and gateways keep their standard size)
- {"op":"tidy"}   (clean-up pass on the whole diagram: empty columns closed and the pool trimmed, rows pulled up when the gap above is too large, one exit side per gateway flow, flows redrawn (fewest conflicts then fewest bends, possibly redrawing the other flow of a crossing), labels re-placed at their fixed distance, comments trimmed, resized and moved next to their element; reports what is left. Run automatically after relayout)
- reroute also accepts "side":"top|bottom|left|right" = the side of the source the flow leaves from. Two flows must never leave a gateway from the same side (it would look like one branches off the other): reroute refuses it.
- {"op":"move","id":"<id>","next_to":"<otherId>","side":"right|left|below|above","gap":50}   (or "x","y" = new centre, or "dx","dy"; connected flows follow; if the spot is taken the element slides to the nearest free spot unless "avoid_overlap":false). With "label":true and dx/dy, moves only the label of an element or a flow
- {"op":"set_timer","id":"<eventId>","kind":"timeDuration|timeDate|timeCycle","value":"P3D"}
- {"op":"set_interrupting","id":"<boundaryOrEventSubprocessStartId>","value":false}
- {"op":"set_condition","id":"<sequenceFlowId>","expression":"\${montant > 1000}"}
- {"op":"set_default","gateway":"<gatewayId>","flow":"<sequenceFlowId>"}
- {"op":"set_error","id":"<eventId>","name":"Dossier expiré","code":"DOSSIER_EXPIRE"}   (also set_message / set_signal / set_escalation with "name")

Element types: bpmn:Task, bpmn:UserTask, bpmn:ServiceTask, bpmn:ScriptTask, bpmn:SendTask, bpmn:ReceiveTask, bpmn:ManualTask, bpmn:BusinessRuleTask, bpmn:CallActivity, bpmn:SubProcess, bpmn:StartEvent, bpmn:EndEvent, bpmn:IntermediateCatchEvent, bpmn:IntermediateThrowEvent, bpmn:ExclusiveGateway, bpmn:ParallelGateway, bpmn:InclusiveGateway, bpmn:EventBasedGateway, bpmn:TextAnnotation.
"event" (for events, attach and replace): none | timer | message | error | signal | escalation | compensate | conditional | terminate. With "event":"timer" you may add "timer":{"kind":"timeDuration","value":"P3D"}.
Timers use ISO 8601: P3D, PT48H, R3/P1D (3 times, every day), or an expression like \${dueDate} with kind timeDate.`;
