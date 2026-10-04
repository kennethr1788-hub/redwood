import {createServer} from 'node:http';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

/** Synthetic owned fixture. The audited root reads the exact file selected for source patches. */
export async function startSelectedStackFixture(sourceDir) {
  await mkdir(sourceDir, {recursive: true});
  const requests = [];
  let origin;
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, origin).pathname;
    requests.push(pathname);
    res.setHeader('Cache-Control', 'no-store');
    if (pathname === '/robots.txt') {
      res.setHeader('Content-Type', 'text/plain');
      return res.end(`User-agent: *\nDisallow: /admin\nSitemap: ${origin}/sitemap.xml\n`);
    }
    if (pathname === '/sitemap.xml') {
      res.setHeader('Content-Type', 'application/xml');
      return res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/about', '/admin', '/app', '/overflow'].map(route => `<url><loc>${origin}${route}</loc></url>`).join('')}</urlset>`);
    }
    if (pathname === '/unavailable503') {
      res.writeHead(503, {'Content-Type': 'text/plain'});
      return res.end('Synthetic fixture unavailable. No successful audit should be claimed.');
    }
    if (!['/', '/about', '/app', '/admin', '/overflow'].includes(pathname)) {
      res.writeHead(404, {'Content-Type': 'text/plain'});
      return res.end('Not found');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Robots-Tag', pathname === '/admin' ? 'noindex' : 'index, follow');
    try {
      if (pathname === '/') return res.end(await readFile(path.join(sourceDir, 'index.html')));
      return res.end(document(origin, pathname));
    } catch {
      res.statusCode = 500;
      return res.end('Fixture source could not be read.');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  await writeFile(path.join(sourceDir, 'index.html'), document(origin, '/'));
  return {
    origin, requests, sourceDir,
    requestCounts: () => Object.fromEntries([...new Set(requests)].sort().map(route => [route, requests.filter(value => value === route).length])),
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function document(origin, route) {
  const app = route === '/app';
  const title = app ? 'Loading Field Notes workspace' : route === '/' ? 'Field Notes | A calmer place for ideas' : 'About Field Notes';
  // Missing root description is proposed in Grow and repaired by the external test-owned coding step.
  const description = route === '/' || app ? '' : '<meta name="description" content="Field Notes keeps project notes, decisions and next steps together.">';
  const schema = {'@context': 'https://schema.org', '@type': route === '/' ? 'WebSite' : 'WebPage', name: 'Field Notes', url: `${origin}${route}`};
  return `<!doctype html>
<html lang="en"${app ? '' : ' data-ready="true"'}>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>${description}<link rel="canonical" href="${origin}${route}">
<meta property="og:title" content="${title}"><meta property="og:description" content="Project notes, decisions and next steps. Together at last."><meta property="og:type" content="website"><meta property="og:url" content="${origin}${route}"><meta name="robots" content="index, follow">
<script type="application/ld+json">${JSON.stringify(schema)}</script>
<style>body{margin:0;background:#f7f5ef;color:#242c26;font:18px/1.6 system-ui,sans-serif}header,main,footer{max-width:1000px;margin:auto;padding:28px}nav{display:flex;gap:22px;flex-wrap:wrap}a{color:#29553a}h1{font-size:clamp(36px,6vw,66px);line-height:1.05;max-width:760px}main{padding-top:72px;padding-bottom:100px}section{padding:24px 0;border-top:1px solid #d9ddd4}.eyebrow{color:#52654f;font-size:13px;letter-spacing:.15em;text-transform:uppercase}.button{display:inline-block;padding:12px 22px;background:#294c35;color:white;border-radius:6px;text-decoration:none}footer{font-size:14px;border-top:1px solid #d9ddd4}</style></head>
<body><header><nav aria-label="Main navigation"><a href="/">Field Notes</a><a href="/about">About</a><a href="/app">Workspace</a><a href="/admin">Private admin</a></nav></header>
<main><p class="eyebrow">A shared space for the details</p><h1>${app ? title : 'Make room for your best ideas.'}</h1><p>Field Notes brings project notes, decisions and next steps into one clear workspace.</p><a class="button" href="/app">Explore the workspace</a><section><h2>Keep the project story together</h2><p>Record decisions, organize notes and share the next steps. This fixture describes a synthetic product for local testing.</p></section><section><h2>Built for thoughtful teams</h2><p>Review the source before using its product copy. No external scripts, accounts, analytics or paid services are used here.</p></section></main><footer>Field Notes · Synthetic local acceptance fixture.</footer>
${app ? `<script>setTimeout(() => { document.title = 'Field Notes workspace — ready'; document.querySelector('h1').textContent = document.title; document.querySelector('meta[property="og:title"]').content = document.title; const description = document.createElement('meta'); description.name = 'description'; description.content = 'Review project notes and next steps in the rendered Field Notes workspace.'; document.head.append(description); document.documentElement.dataset.ready = 'true'; }, 100);</script>` : ''}
</body></html>\n`;
}
