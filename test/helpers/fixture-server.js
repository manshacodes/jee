import { createServer } from 'node:http';

/**
 * Serves fixture HTML over real HTTP so the scrapers exercise their actual
 * fetch path (redirects, retries, status handling) rather than a stubbed one.
 *
 * @param {Record<string,string>} routes  path -> HTML
 */
export async function fixtureServer(routes) {
  const server = createServer((req, res) => {
    const body = routes[req.url];
    if (body === undefined) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
