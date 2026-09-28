Diagrams: instead of hand-writing HTML, pick a template and give it JSON; it's drawn consistently.
`claude-glass new diagram --id arch` then `claude-glass app arch show --template T --data '<json>'`
(or `--data-file f.json`; optional "title"; items take "note" and "tone": good|bad|warn|info|muted):
- flow {"steps":[{"title","note"}]}: steps in order
- sequence {"actors":["A","B"],"messages":[{"from","to","text","reply":true}]}
- layers {"layers":[{"title","items":["…"]}]}: architecture, top to bottom
- timeline {"events":[{"when","title","note"}]}
- compare {"columns":[{"title","points":["…"]}]}: options side by side
- tree {"root":{"title","children":[…]}}: hierarchy
- cycle {"steps":[{"title"}]}: a loop
- stats {"items":[{"label","value","delta"}]}: headline numbers
