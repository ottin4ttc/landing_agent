// landingAgent-specific (not upstream openclaw)
// Stub for Task 9's routes; Task 10 replaces this with the full dashboard page.
export function renderDashboardHtml(session: { open_id: string; name: string | null }): string {
  const name = session.name ?? session.open_id;
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>landingAgent QA</title>
  </head>
  <body>
    <h1>landingAgent QA</h1>
    <p>Welcome, ${name}</p>
    <div id="cards"></div>
  </body>
</html>`;
}
