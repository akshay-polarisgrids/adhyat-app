// Crawls oshoworld's sitemap, groups every audio discourse into its series (album), writes data/catalog.json.
const fs = require('fs');
const path = require('path');
const { HOST, get, fetchTrack } = require('../lib');

const OUT = path.join(__dirname, '..', 'data', 'catalog.json');
const CONCURRENCY = 8;

async function sitemapSlugs() {
  const { body } = await get(`${HOST}/sitemap.xml`);
  const slugs = new Set();
  for (const m of body.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const parts = new URL(m[1]).pathname.split('/').filter(Boolean);
    if (parts.length === 1) slugs.add(parts[0]);
  }
  return [...slugs];
}

async function main() {
  const slugs = await sitemapSlugs();
  console.log(`${slugs.length} pages in sitemap, probing for discourses...`);
  const byId = new Map();
  let i = 0;
  let done = 0;
  async function worker() {
    while (i < slugs.length) {
      const slug = slugs[i++];
      try {
        const t = await fetchTrack(slug);
        if (t) {
          const s = byId.get(t.series.id) || { ...t.series, tracks: [] };
          s.tracks.push(t.track);
          byId.set(s.id, s);
        }
      } catch (e) {
        console.error('skip', slug, e.message);
      }
      if (++done % 1000 === 0) console.log(`${done}/${slugs.length}, ${byId.size} series`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const series = [...byId.values()].sort((a, b) => a.title.localeCompare(b.title));
  for (const s of series) {
    s.tracks.sort((a, b) => a.n - b.n);
    const cover = s.tracks.find(t => t.image && !/no_image/.test(t.image)) || s.tracks[0];
    s.image = cover.image;
    for (const t of s.tracks) delete t.image;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT + '.tmp', JSON.stringify({ updated: new Date().toISOString(), series }));
  fs.renameSync(OUT + '.tmp', OUT);
  const tracks = series.reduce((n, s) => n + s.tracks.length, 0);
  console.log(`wrote ${series.length} series, ${tracks} tracks`);
}

main().catch(e => { console.error(e); process.exit(1); });
