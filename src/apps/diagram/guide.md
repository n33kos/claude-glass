Diagrams: instead of hand-writing HTML, pick a template and give it JSON; it's drawn consistently and
fits any window size. `claude-glass new diagram --id arch` then
`claude-glass app arch show --template T --data '<json>'` (or `--data-file f.json`; optional "title").
Items are strings or {"title","note","tone"}; tone: good|bad|warn|info|muted (bad is the only red).
- flow {"steps":[…]}: a process in order (a pipeline, a request path, steps of a fix). 2–8 steps.
- sequence {"actors":["A","B"],"messages":[{"from","to","text","reply":true}]}: who calls whom, in order.
- layers {"layers":[{"title","note","items":["…"]}]}: architecture or a stack, top to bottom.
- timeline {"events":[{"when","title","note"}]}: what happened when (an incident, a release history).
- compare {"columns":[{"title","note","tone":"good","points":["…"]}]}: options side by side; mark the
  pick with tone good; keep points short (a few words) and 2–4 options.
- tree {"root":{"title","children":[…]}}: a hierarchy (modules, a decision breakdown).
- cycle {"steps":[…],"center":"label"}: a loop that repeats.
- stats {"items":[{"label","value","delta","trend":[1,3,2]}]}: a few headline numbers.
Choose the template that matches the shape of the idea; titles short, detail in "note".
Reuse one diagram window (same --id) and move it to 0 when you update it.
